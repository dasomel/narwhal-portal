import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getNodeDetail, getPodsByNode } from "@/lib/k8s-client"
import { getNodeMetrics, getNodePodCount } from "@/lib/prometheus"
import { MetricChart } from "@/components/dashboard/metric-chart"
import { AuditTabClient } from "@/components/nodes/audit/audit-tab-client"
import { Info, LayoutGrid, BarChart3, Database, Activity, Cpu, Clock, Globe } from "lucide-react"
import { getLocale } from "@/lib/i18n-server"
import { t as translate } from "@/lib/i18n"
import type { TranslationKey, Locale } from "@/lib/i18n"
import { auth } from "@/lib/auth"

async function getNodeData(name: string) {
  const [detail, metrics, podCount, pods] = await Promise.all([
    getNodeDetail(name),
    getNodeMetrics(),
    getNodePodCount(name),
    getPodsByNode(name),
  ])

  if (!detail) return null

  const nodeMetrics = metrics.find((m) => m.node === name)

  return {
    detail,
    cpuUsage: nodeMetrics?.cpu.usagePercent ?? 0,
    memoryUsage: nodeMetrics?.memory.usagePercent ?? 0,
    diskUsage: nodeMetrics?.disk.usagePercent ?? 0,
    podCount,
    pods,
  }
}

function formatGi(bytes: string): string {
  if (!bytes) return "0G"
  const val = parseFloat(bytes)
  if (bytes.toLowerCase().endsWith("ki")) return (val / (1024 * 1024)).toFixed(1) + "G"
  if (bytes.toLowerCase().endsWith("mi")) return (val / 1024).toFixed(1) + "G"
  if (bytes.toLowerCase().endsWith("gi")) return val.toFixed(1) + "G"
  return (val / (1024 ** 3)).toFixed(1) + "G"
}

function formatUptime(createdAt: string, locale: Locale): string {
  const created = new Date(createdAt).getTime()
  const now = Date.now()
  const diff = now - created
  
  const minuteEn = 60 * 1000
  const hourEn = 60 * minuteEn
  const dayEn = 24 * hourEn
  const monthEn = 30 * dayEn
  const yearEn = 365 * dayEn

  const years = Math.floor(diff / yearEn)
  const months = Math.floor((diff % yearEn) / monthEn)
  const days = Math.floor((diff % monthEn) / dayEn)
  const hours = Math.floor((diff % dayEn) / hourEn)
  const mins = Math.floor((diff % hourEn) / minuteEn)
  
  const parts = []

  if (years > 0) parts.push(translate(locale, "time.years", { count: years }))
  if (months > 0) parts.push(translate(locale, "time.months", { count: months }))
  if (days > 0) parts.push(translate(locale, "time.days", { count: days }))
  if (hours > 0) parts.push(translate(locale, "time.hours", { count: hours }))
  if (mins > 0 || parts.length === 0) parts.push(translate(locale, "time.minutes", { count: mins }))
  
  // Show only top 2 units for better readability (e.g., 2년 3달 or 10일 5시간)
  return parts.slice(0, 2).join(" ")
}

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    })
  } catch { return iso }
}

const VALID_TABS = ["overview", "telemetry", "audit"] as const
type TabValue = (typeof VALID_TABS)[number]

export default async function NodeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const [{ name }, sp] = await Promise.all([params, searchParams])
  const initialTab: TabValue = VALID_TABS.includes(sp.tab as TabValue) ? (sp.tab as TabValue) : "overview"
  const [data, locale, session] = await Promise.all([getNodeData(name), getLocale(), auth()])
  const t = (key: TranslationKey) => translate(locale, key)
  const userRole = session?.user?.role

  if (!data) {
    return <div className="p-6 text-red-500 font-bold text-center">Node not found</div>
  }

  const { detail, cpuUsage, memoryUsage, diskUsage, podCount, pods } = data
  const uptime = formatUptime(detail.createdAt, locale)
  const isReady = detail.conditions.find(c => c.type === "Ready")?.status === "True"

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-6 py-8 antialiased">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-foreground font-bold">
           <h1 className="text-2xl font-bold tracking-tight">{detail.name}</h1>
           <Badge variant="outline" className="px-2 font-medium border-border bg-muted/50">{detail.operatingSystem}</Badge>
           <div className="flex items-center gap-1.5 ml-4 text-xs font-bold text-muted-foreground uppercase tracking-widest bg-card border border-border px-3 py-1.5 rounded-md shadow-sm">
             <Clock className="h-3 w-3 text-blue-500" /> {t("nodes.info.uptime")}: <span className="text-foreground">{uptime}</span>
           </div>
        </div>
        <div className="flex gap-2">
           {detail.systemStatus.rebootRequired && <Badge variant="destructive" className="font-bold px-3 py-1 h-7 text-xs uppercase">{t("nodes.status.reboot")}</Badge>}
           <Badge className={`${isReady ? 'bg-emerald-600' : 'bg-rose-600'} text-white font-bold px-3 py-1 h-7 text-xs leading-none uppercase tracking-wide`}>
             {isReady ? t("nodes.status.ready") : t("nodes.status.notReady")}
           </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="p-5 shadow-sm border-border ring-1 ring-border bg-card">
           <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest leading-none">{t("nodes.metric.cpu")}</p>
           <p className={`text-3xl font-black mt-2.5 ${cpuUsage > 80 ? 'text-red-500' : 'text-foreground'}`}>{cpuUsage}%</p>
           <div className="flex items-center gap-2 mt-4">
             <div className="flex-1 bg-muted h-1.5 rounded-full overflow-hidden leading-[0]">
               <div className="bg-blue-600 h-full rounded-full transition-all duration-1000" style={{ width: `${cpuUsage}%` }} />
             </div>
             <span className="text-xs font-bold text-muted-foreground mt-0.5">{cpuUsage}%</span>
           </div>
        </Card>
        <Card className="p-5 shadow-sm border-border ring-1 ring-border bg-card">
           <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest leading-none">{t("nodes.metric.memory")}</p>
           <p className={`text-3xl font-black mt-2.5 ${memoryUsage > 80 ? 'text-red-500' : 'text-foreground'}`}>{memoryUsage}%</p>
           <div className="flex items-center gap-2 mt-4">
             <div className="flex-1 bg-muted h-1.5 rounded-full overflow-hidden leading-[0]">
               <div className="bg-green-600 h-full rounded-full transition-all duration-1000" style={{ width: `${memoryUsage}%` }} />
             </div>
             <span className="text-xs font-bold text-muted-foreground mt-0.5">{memoryUsage}%</span>
           </div>
        </Card>
        <Card className="p-5 shadow-sm border-border ring-1 ring-border bg-card">
           <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest leading-none">{t("nodes.metric.disk")}</p>
           <p className={`text-3xl font-black mt-2.5 ${diskUsage > 80 ? 'text-red-500' : 'text-foreground'}`}>{diskUsage}%</p>
           <div className="flex items-center gap-2 mt-4">
             <div className="flex-1 bg-muted h-1.5 rounded-full overflow-hidden leading-[0]">
               <div className="bg-amber-500 h-full rounded-full transition-all duration-1000" style={{ width: `${diskUsage}%` }} />
             </div>
             <span className="text-xs font-bold text-muted-foreground mt-0.5">{diskUsage}%</span>
           </div>
        </Card>
        <Card className="p-5 shadow-sm border-border ring-1 ring-border bg-card shadow-blue-50/50">
           <p className="text-xs text-blue-600 font-bold uppercase tracking-widest leading-none">{t("nodes.metric.pods")}</p>
           <p className="text-3xl font-black mt-2.5 text-foreground font-mono tracking-tighter">{podCount}<span className="text-sm font-bold text-muted-foreground/50 ml-1.5">/ {detail.capacity.pods}</span></p>
           <div className="flex items-center gap-2 mt-4">
             <div className="flex-1 bg-muted h-1.5 rounded-full overflow-hidden leading-[0]">
               <div className="bg-narwhal-accent h-full rounded-full transition-all duration-1000" style={{ width: `${(podCount / parseInt(detail.capacity.pods)) * 100}%` }} />
             </div>
             <span className="text-xs font-bold text-muted-foreground mt-0.5">{Math.round((podCount / parseInt(detail.capacity.pods)) * 100)}%</span>
           </div>
        </Card>
      </div>

      <Tabs defaultValue={initialTab} className="w-full">
        <TabsList className="bg-muted/50 p-1 rounded-xl h-12 flex items-stretch gap-1 w-fit border border-border/50 shadow-sm">
          <TabsTrigger value="overview" className="flex-1 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.03] transition-all font-black text-xs uppercase tracking-widest px-8 rounded-lg text-muted-foreground">{t("nodes.tab.overview")}</TabsTrigger>
          <TabsTrigger value="telemetry" className="flex-1 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.03] transition-all font-black text-xs uppercase tracking-widest px-8 rounded-lg text-muted-foreground">{t("nodes.tab.telemetry")}</TabsTrigger>
          <TabsTrigger value="audit" className="flex-1 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-md data-[state=active]:scale-[1.03] transition-all font-black text-xs uppercase tracking-widest px-8 rounded-lg text-muted-foreground">{t("nodes.tab.audit")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 pt-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            <div className="lg:col-span-1 space-y-6">
              <Card className="shadow-sm border-border rounded-xl overflow-hidden bg-card">
                <CardHeader className="py-4 border-b bg-muted/50/30 px-5">
                  <CardTitle className="text-xs font-bold flex items-center gap-2 text-foreground uppercase tracking-widest leading-none"><Info className="h-4 w-4 text-muted-foreground" /> {t("nodes.info.infra")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pt-6 text-sm px-5 pb-6">
                   {[
                    [t("nodes.info.ip"), detail.internalIP, <Globe className="h-4 w-4 text-muted-foreground" />],
                    [t("nodes.info.os"), detail.osImage, <Globe className="h-4 w-4 text-muted-foreground" />],
                    [t("nodes.info.kernel"), detail.kernelVersion, <Activity className="h-4 w-4 text-muted-foreground" />],
                    [t("nodes.info.arch"), detail.architecture, <Cpu className="h-4 w-4 text-muted-foreground" />],
                    [t("nodes.info.createdAt"), formatDate(detail.createdAt, locale), <Clock className="h-4 w-4 text-muted-foreground" />]
                   ].map(([l, v, icon]) => (
                      <div key={l as string} className="flex flex-col gap-1.5 border-b border-border/50 pb-3.5 last:border-0 hover:bg-muted/50/40 transition-colors rounded px-4 -mx-4 -mt-2 pt-2">
                         <div className="flex items-center gap-2.5 text-xs text-muted-foreground font-black uppercase tracking-widest leading-none">{icon}{l as string}</div>
                         <div className="font-bold text-foreground break-all leading-tight" title={v as string}>{v as string}</div>
                      </div>
                    ))}
                </CardContent>
              </Card>

              <Card className="shadow-sm border-border rounded-xl overflow-hidden bg-card">
                <CardHeader className="py-4 border-b bg-muted/50/30 px-5">
                  <CardTitle className="text-xs font-bold flex items-center gap-2 text-foreground uppercase tracking-widest leading-none"><Database className="h-4 w-4 text-muted-foreground" /> {t("nodes.info.resources")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pt-6 text-sm px-5 pb-6">
                   {[
                    [t("nodes.info.capCpu"), detail.capacity.cpu],
                    [t("nodes.info.capMem"), formatGi(detail.capacity.memory)],
                    [t("nodes.info.allocCpu"), detail.allocatable.cpu],
                    [t("nodes.info.allocMem"), formatGi(detail.allocatable.memory)],
                    [t("nodes.info.kubelet"), detail.kubeletVersion]
                   ].map(([l, v]) => (
                      <div key={l as string} className="flex justify-between border-b border-border/50 pb-3 last:border-0 hover:bg-muted/50/40 transition-colors rounded px-4 -mx-4 -mt-2 pt-2 items-center">
                         <span className="text-xs text-muted-foreground font-bold uppercase tracking-widest leading-none">{l as string}</span>
                         <span className="font-bold text-foreground">{v as string}</span>
                      </div>
                    ))}
                </CardContent>
              </Card>
            </div>

            <Card className="lg:col-span-2 shadow-sm border-border rounded-xl overflow-hidden bg-card">
              <CardHeader className="py-4 border-b bg-muted/50/30 px-5">
                <CardTitle className="text-xs font-bold flex items-center gap-2 text-foreground uppercase tracking-widest leading-none"><LayoutGrid className="h-4 w-4 text-muted-foreground" /> {t("nodes.workload.title")}</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-left text-xs">
                  <thead className="bg-card text-xs font-black text-muted-foreground border-b uppercase tracking-[0.15em] border-border">
                    <tr><th className="px-8 py-4.5">{t("nodes.workload.namespace")}</th><th className="px-8 py-4.5">{t("nodes.workload.name")}</th><th className="px-8 py-4.5 text-right">{t("nodes.workload.status")}</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border/50 font-medium leading-tight text-sm">
                    {pods.map(p => (
                      <tr key={p.name} className="hover:bg-muted/50 transition-all duration-200 group">
                        <td className="px-8 py-4 text-muted-foreground uppercase tracking-wider font-bold group-hover:text-foreground transition-colors">{p.namespace}</td>
                        <td className="px-8 py-4 text-foreground font-medium tracking-tight truncate max-w-[200px]" title={p.name}>{p.name}</td>
                        <td className="px-8 py-4 text-right"><Badge variant="outline" className="font-bold text-[9px] px-3 h-5 leading-none text-emerald-600 border-emerald-100 bg-emerald-50 rounded-full shadow-sm tracking-widest uppercase">{t("health.healthy")}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="telemetry" className="pt-6">
           <Card className="p-12 border border-border shadow-sm bg-card rounded-2xl sm:p-6">
              <CardHeader className="py-4 border-b p-0 mb-12 sm:mb-8">
                 <CardTitle className="text-xs font-bold flex items-center gap-2 text-foreground uppercase tracking-widest"><BarChart3 className="h-4 w-4 text-blue-500" /> {t("nodes.tab.telemetryAnalysis")}</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 min-h-[350px]">
                    <MetricChart metric="cpu" minutes={60} node={detail.name} />
                    <MetricChart metric="memory" minutes={60} node={detail.name} />
                    <MetricChart metric="network" minutes={60} node={detail.name} />
                    <MetricChart metric="disk" minutes={60} node={detail.name} />
                 </div>
              </CardContent>
           </Card>
        </TabsContent>

        <TabsContent value="audit" className="pt-6">
          <AuditTabClient
            systemStatus={detail.systemStatus}
            locale={locale}
            nodeName={detail.name}
            userRole={userRole}
            auditTitleLabel={t("nodes.audit.title")}
            scanInsightLabel={t("nodes.audit.scanInsight")}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
