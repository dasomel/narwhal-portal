"use client"

import { useEffect, useRef } from "react"
import type { MascotState } from "@/types/api"

interface NarwhalProps {
  state: MascotState
  size?: number
}

export function Narwhal({ state, size = 120 }: NarwhalProps) {
  const groupRef = useRef<SVGGElement>(null)

  // Idle breath animation — healthy only, respects prefers-reduced-motion
  useEffect(() => {
    const el = groupRef.current
    if (!el) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    if (mq.matches || state !== "healthy") {
      el.style.animation = "none"
      return
    }
    el.style.animation = "narwhal-breath 3s ease-in-out infinite"
    el.style.transformOrigin = "center"
    return () => {
      el.style.animation = "none"
    }
  }, [state])

  const viewBox = "0 0 220 120"
  const svgStyle = { width: size, height: size * 0.545, display: "block" }

  if (state === "healthy") {
    return (
      <svg viewBox={viewBox} style={svgStyle} aria-label="Narwhal healthy" role="img">
        <g ref={groupRef}>
          <ellipse cx="100" cy="68" rx="60" ry="28" fill="#0891b2" />
          <path d="M100,68 Q100,90 152,82 Q150,72 100,68 Z" fill="#67e8f9" />
          <path d="M42,68 L18,48 L22,70 L18,88 Z" fill="#0891b2" />
          <path d="M90,40 L75,28 L102,36 Z" fill="#0e7490" />
          <ellipse cx="88" cy="78" rx="10" ry="5" fill="#0e7490" />
          {/* horn */}
          <line x1="158" y1="66" x2="212" y2="36" stroke="var(--narwhal-horn)" strokeWidth="4" strokeLinecap="round" />
          <line x1="162" y1="62" x2="210" y2="34" stroke="var(--narwhal-horn)" strokeWidth="1.5" strokeDasharray="3,3" />
          {/* eye */}
          <circle cx="138" cy="60" r="5" fill="#f8fafc" />
          <circle cx="139" cy="61" r="2.5" fill="#020617" />
          <circle cx="140" cy="60" r="0.8" fill="#f8fafc" />
          {/* smile */}
          <path d="M128,74 Q135,78 144,74" stroke="#0e7490" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </g>
      </svg>
    )
  }

  if (state === "warning") {
    return (
      <svg viewBox={viewBox} style={svgStyle} aria-label="Narwhal warning" role="img">
        <ellipse cx="100" cy="68" rx="60" ry="28" fill="#0891b2" />
        <path d="M100,68 Q100,90 152,82 Q150,72 100,68 Z" fill="#67e8f9" />
        <path d="M42,68 L18,48 L22,70 L18,88 Z" fill="#0891b2" />
        <path d="M90,40 L75,28 L102,36 Z" fill="#0e7490" />
        <ellipse cx="88" cy="78" rx="10" ry="5" fill="#0e7490" />
        {/* horn */}
        <line x1="158" y1="66" x2="212" y2="36" stroke="var(--narwhal-horn)" strokeWidth="4" strokeLinecap="round" />
        <line x1="162" y1="62" x2="210" y2="34" stroke="var(--narwhal-horn)" strokeWidth="1.5" strokeDasharray="3,3" opacity="0.6" />
        {/* eye — raised */}
        <circle cx="138" cy="60" r="5" fill="#f8fafc" />
        <circle cx="139" cy="58" r="2.8" fill="#020617" />
        {/* concerned mouth */}
        <path d="M128,75 Q136,74 144,75" stroke="#0e7490" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        {/* yellow eyebrow hint */}
        <path d="M128,52 Q132,48 136,52" stroke="#facc15" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        {/* "!" near horn tip */}
        <text x="175" y="20" fontSize="16" fill="#facc15" fontWeight="bold" fontFamily="system-ui">!</text>
      </svg>
    )
  }

  if (state === "critical") {
    return (
      <svg viewBox={viewBox} style={svgStyle} aria-label="Narwhal critical" role="img">
        {/* body tilted */}
        <ellipse cx="100" cy="72" rx="60" ry="26" fill="#0891b2" transform="rotate(-3 100 72)" />
        <path d="M100,72 Q100,92 152,86 Q150,76 100,72 Z" fill="#67e8f9" />
        <path d="M42,72 L18,52 L22,74 L18,92 Z" fill="#0891b2" />
        <path d="M90,44 L75,32 L102,40 Z" fill="#0e7490" />
        <ellipse cx="88" cy="82" rx="10" ry="5" fill="#0e7490" />
        {/* red horn glow */}
        <line x1="158" y1="68" x2="212" y2="40" stroke="#fca5a5" strokeWidth="4" strokeLinecap="round" />
        <line x1="162" y1="64" x2="210" y2="38" stroke="#fecaca" strokeWidth="1.5" strokeDasharray="3,3" />
        {/* wide eyes */}
        <circle cx="138" cy="62" r="5" fill="#f8fafc" />
        <circle cx="138" cy="60" r="3.2" fill="#020617" />
        {/* worry mouth */}
        <path d="M126,80 Q135,76 144,80" stroke="#0e7490" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        {/* warning burst / X symbol */}
        <path d="M200,24 L210,36 M210,24 L200,36" stroke="#f87171" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="205" cy="30" r="10" fill="none" stroke="#f87171" strokeWidth="1.5" opacity="0.5" />
      </svg>
    )
  }

  // loading state
  return (
    <svg viewBox={viewBox} style={svgStyle} aria-label="Narwhal loading" role="img">
      <ellipse cx="100" cy="70" rx="60" ry="26" fill="#0891b2" opacity="0.7" />
      <path d="M100,70 Q100,90 152,84 Q150,74 100,70 Z" fill="#67e8f9" opacity="0.7" />
      <path d="M42,70 L18,50 L22,72 L18,90 Z" fill="#0891b2" opacity="0.7" />
      <path d="M90,42 L75,30 L102,38 Z" fill="#0e7490" opacity="0.7" />
      <ellipse cx="88" cy="80" rx="10" ry="5" fill="#0e7490" opacity="0.5" />
      {/* horn — reduced opacity */}
      <line x1="158" y1="68" x2="212" y2="38" stroke="var(--narwhal-horn)" strokeWidth="4" strokeLinecap="round" opacity="0.7" />
      {/* eyes closed */}
      <path d="M132,62 Q138,58 144,62" stroke="#020617" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {/* mouth */}
      <path d="M128,76 Q135,74 144,76" stroke="#0e7490" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.7" />
      {/* bubble particles */}
      <circle cx="180" cy="24" r="2" fill="#22d3ee" style={{ animation: "bubble-float 2s ease-in-out infinite" }} opacity="0.6" />
      <circle cx="192" cy="22" r="1.5" fill="#22d3ee" style={{ animation: "bubble-float 2s ease-in-out 0.4s infinite" }} opacity="0.4" />
      <circle cx="204" cy="18" r="1" fill="#22d3ee" style={{ animation: "bubble-float 2s ease-in-out 0.8s infinite" }} opacity="0.3" />
    </svg>
  )
}
