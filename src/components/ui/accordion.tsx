"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

export function Accordion({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>
}

export function AccordionItem({
  children,
  value,
  className,
  open: controlledOpen,
  onOpenChange,
  id,
}: {
  children: React.ReactNode
  value: string
  className?: string
  /** Controlled open state. When provided, internal state is overridden. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  id?: string
}) {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : internalOpen
  const setIsOpen = (v: boolean) => {
    if (!isControlled) setInternalOpen(v)
    onOpenChange?.(v)
  }

  return (
    <div id={id} className={`border-b border-gray-100 last:border-0 ${className}`}>
      {React.Children.map(children, child => {
        if (React.isValidElement(child)) {
          return React.cloneElement(child as React.ReactElement<any>, { isOpen, setIsOpen })
        }
        return child
      })}
    </div>
  )
}

export function AccordionTrigger({ children, isOpen, setIsOpen, className }: { children: React.ReactNode; isOpen?: boolean; setIsOpen?: (v: boolean) => void; className?: string }) {
  return (
    <button
      onClick={() => setIsOpen?.(!isOpen)}
      className={`flex w-full items-center justify-between py-4 font-medium transition-all hover:underline ${className}`}
    >
      {children}
      <ChevronDown className={`h-4 w-4 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
    </button>
  )
}

export function AccordionContent({ children, isOpen, className }: { children: React.ReactNode; isOpen?: boolean; className?: string }) {
  if (!isOpen) return null
  return <div className={`pb-4 pt-0 text-sm transition-all animate-in fade-in slide-in-from-top-1 ${className}`}>{children}</div>
}
