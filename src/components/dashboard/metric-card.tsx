import { Card } from "@/components/ui/card"

interface MetricCardProps {
  title: string
  value: string | number | null
  subtitle?: string
  color?: "default" | "green" | "yellow" | "red"
}

const colorMap = {
  default: "text-foreground",
  green: "text-narwhal-success",
  yellow: "text-narwhal-warning",
  red: "text-narwhal-danger",
}

export function MetricCard({ title, value, subtitle, color = "default" }: MetricCardProps) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted-foreground font-medium">{title}</p>
      <p className={`text-3xl font-bold mt-1 ${colorMap[color]}`}>
        {value === null ? "—" : value}
      </p>
      {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
    </Card>
  )
}
