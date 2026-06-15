// 자동 적용 화이트리스트.
// 프론트엔드에서 받은 페이로드는 식별자만 사용하고, 실제 명령은 여기서 안전하게 재구성합니다.

export type ApplyTarget =
  | { kind: "kernel-param"; param: string; value: string }
  | { kind: "kernel-module"; module: string }
  | { kind: "ulimit"; name: "nofile" | "nproc" | "memlock"; scope: "soft" | "hard"; value: string }
  | { kind: "package"; name: string }
  | { kind: "swap-off" }
  | { kind: "service-enable"; service: string }
  | { kind: "ethtool"; iface: string; rx: number; tx: number }
  | { kind: "tuning-script"; script: string }

const SAFE_PARAM = /^[a-z0-9_.\-]+$/i
const SAFE_VALUE = /^[a-zA-Z0-9_.,:\-\/\s]+$/
const SAFE_IFACE = /^[a-z0-9]+$/i
const ALLOWED_PACKAGES = new Set(["socat", "conntrack", "ipset", "ipvsadm", "ebtables", "jq"])
const ALLOWED_SERVICES = new Set(["containerd", "kubelet", "extend-lvm.service"])
const ALLOWED_SCRIPTS = new Set(["05-disk-tuning.sh", "06-network-tuning.sh"])
const ALLOWED_ULIMIT_VALUES = /^([0-9]+|unlimited)$/
const ALLOWED_MODULES = new Set([
  "br_netfilter", "overlay", "ip_vs", "ip_vs_rr", "ip_vs_wrr", "ip_vs_sh", "nf_conntrack",
])

const SYSCTL_FILE: Record<string, string> = {
  "net.bridge.bridge-nf-call-iptables":  "/etc/sysctl.d/k8s-network.conf",
  "net.bridge.bridge-nf-call-ip6tables": "/etc/sysctl.d/k8s-network.conf",
  "net.ipv4.ip_forward":                 "/etc/sysctl.d/k8s-network.conf",
  "net.ipv6.conf.all.disable_ipv6":      "/etc/sysctl.d/k8s-disable-ipv6.conf",
  "net.ipv6.conf.default.disable_ipv6":  "/etc/sysctl.d/k8s-disable-ipv6.conf",
  "net.ipv6.conf.lo.disable_ipv6":       "/etc/sysctl.d/k8s-disable-ipv6.conf",
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Returns shell commands for a single ApplyTarget. All commands run on the host
 * via nsenter from a privileged Job (see k8s-job-runner.ts).
 *
 * Throws if the target fails whitelist validation — caller MUST catch.
 */
export function buildCommands(target: ApplyTarget): string[] {
  switch (target.kind) {
    case "kernel-param": {
      if (!SAFE_PARAM.test(target.param)) throw new Error(`invalid param: ${target.param}`)
      if (!SAFE_VALUE.test(target.value)) throw new Error(`invalid value: ${target.value}`)
      const file = SYSCTL_FILE[target.param] ?? "/etc/sysctl.d/99-k8s-tuning.conf"
      const safeParam = shellEscape(target.param)
      const safeValue = shellEscape(target.value)
      const safeFile = shellEscape(file)
      return [
        `sysctl -w ${target.param}=${safeValue}`,
        `mkdir -p /etc/sysctl.d`,
        `grep -v ${safeParam} ${safeFile} 2>/dev/null > ${safeFile}.tmp || true`,
        `echo ${shellEscape(`${target.param} = ${target.value}`)} >> ${safeFile}.tmp`,
        `mv ${safeFile}.tmp ${safeFile}`,
      ]
    }

    case "kernel-module": {
      if (!ALLOWED_MODULES.has(target.module)) throw new Error(`module not allowed: ${target.module}`)
      const safe = shellEscape(target.module)
      return [
        `modprobe ${safe}`,
        `mkdir -p /etc/modules-load.d`,
        `grep -v ${safe} /etc/modules-load.d/k8s.conf 2>/dev/null > /etc/modules-load.d/k8s.conf.tmp || true`,
        `echo ${safe} >> /etc/modules-load.d/k8s.conf.tmp`,
        `mv /etc/modules-load.d/k8s.conf.tmp /etc/modules-load.d/k8s.conf`,
      ]
    }

    case "ulimit": {
      if (!ALLOWED_ULIMIT_VALUES.test(target.value)) throw new Error(`invalid ulimit value`)
      const file = "/etc/security/limits.d/k8s.conf"
      const safeFile = shellEscape(file)
      const line = `* ${target.scope} ${target.name} ${target.value}`
      const grepPattern = shellEscape(`${target.scope} ${target.name} `)
      return [
        `mkdir -p /etc/security/limits.d`,
        `grep -v ${grepPattern} ${safeFile} 2>/dev/null > ${safeFile}.tmp || true`,
        `echo ${shellEscape(line)} >> ${safeFile}.tmp`,
        `mv ${safeFile}.tmp ${safeFile}`,
      ]
    }

    case "package": {
      if (!ALLOWED_PACKAGES.has(target.name)) throw new Error(`package not allowed: ${target.name}`)
      return [
        `DEBIAN_FRONTEND=noninteractive apt-get update -qq`,
        `DEBIAN_FRONTEND=noninteractive apt-get install -y ${shellEscape(target.name)}`,
      ]
    }

    case "swap-off": {
      return [
        `swapoff -a`,
        `sed -i.bak '/\\sswap\\s/d' /etc/fstab`,
      ]
    }

    case "service-enable": {
      if (!ALLOWED_SERVICES.has(target.service)) throw new Error(`service not allowed: ${target.service}`)
      return [`systemctl enable --now ${shellEscape(target.service)}`]
    }

    case "ethtool": {
      if (!SAFE_IFACE.test(target.iface)) throw new Error(`invalid iface: ${target.iface}`)
      if (!Number.isInteger(target.rx) || target.rx <= 0 || target.rx > 16384) throw new Error(`invalid rx`)
      if (!Number.isInteger(target.tx) || target.tx <= 0 || target.tx > 16384) throw new Error(`invalid tx`)
      return [`ethtool -G ${target.iface} rx ${target.rx} tx ${target.tx}`]
    }

    case "tuning-script": {
      if (!ALLOWED_SCRIPTS.has(target.script)) throw new Error(`script not allowed: ${target.script}`)
      return [`bash /etc/kube-ready-box/${shellEscape(target.script)}`]
    }
  }
}

/** Builds a single shell script that applies all targets in order, failing fast. */
export function buildJobScript(targets: ApplyTarget[]): string {
  const allCmds: string[] = ["set -euo pipefail", "echo '=== narwhal node tuning apply ==='"]
  for (const t of targets) {
    allCmds.push(`echo '--- ${t.kind} ---'`)
    for (const cmd of buildCommands(t)) {
      allCmds.push(cmd)
    }
  }
  allCmds.push("echo '=== done ==='")
  return allCmds.join("\n")
}
