import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Bot, RefreshCw, FileText, CheckCircle,
  XCircle, Clock, Target, Shield, ChevronDown, ChevronRight, ExternalLink,
  Copy, Download, StopCircle, Terminal, Brain, Send, Code, Globe, AlertTriangle,
  SkipForward, MinusCircle, Pause, Play, Sparkles, X, WifiOff
} from 'lucide-react'
import Card from '../components/common/Card'
import Button from '../components/common/Button'
import { SeverityBadge } from '../components/common/Badge'
import { agentApi, reportsApi } from '../services/api'
import type { AgentStatus, AgentLog, AgentFinding } from '../types'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const PHASE_ICONS: Record<string, React.ReactNode> = {
  initializing: <Clock className="w-4 h-4" />,
  reconnaissance: <Target className="w-4 h-4" />,
  'reconnaissance complete': <Target className="w-4 h-4" />,
  recon: <Target className="w-4 h-4" />,
  'starting reconnaissance': <Target className="w-4 h-4" />,
  scanning: <Shield className="w-4 h-4" />,
  analysis: <Bot className="w-4 h-4" />,
  'attack surface analyzed': <Bot className="w-4 h-4" />,
  testing: <Shield className="w-4 h-4" />,
  'vulnerability testing complete': <Shield className="w-4 h-4" />,
  enhancement: <Brain className="w-4 h-4" />,
  'findings enhanced': <Brain className="w-4 h-4" />,
  reporting: <FileText className="w-4 h-4" />,
  'assessment complete': <CheckCircle className="w-4 h-4" />,
  completed: <CheckCircle className="w-4 h-4" />,
  stopped: <StopCircle className="w-4 h-4" />,
  error: <XCircle className="w-4 h-4" />,
}

const SCAN_PHASES = [
  { key: 'recon', label: 'Reconnaissance', progress: 20 },
  { key: 'analysis', label: 'Analysis', progress: 30 },
  { key: 'testing', label: 'Testing', progress: 70 },
  { key: 'enhancement', label: 'Enhancement', progress: 90 },
  { key: 'completed', label: 'Completed', progress: 100 },
]

const MODE_LABELS: Record<string, string> = {
  full_auto: 'Full Auto',
  recon_only: 'Recon Only',
  prompt_only: 'AI Prompt Mode',
  analyze_only: 'Analyze Only',
}

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getPhaseIndex(phase: string): number {
  const p = phase.toLowerCase()
  if (p.includes('recon') || p.includes('initializing')) return 0
  if (p.includes('analysis') || p.includes('attack surface')) return 1
  if (p.includes('test') || p.includes('vuln')) return 2
  if (p.includes('enhance') || p.includes('finding')) return 3
  if (p.includes('complete') || p.includes('report')) return 4
  return 0
}

function relativeTime(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (diff < 0) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

/* ------------------------------------------------------------------ */
/*  Toast System                                                       */
/* ------------------------------------------------------------------ */

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
}

let _toastSeq = 0

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null
  const borderColor: Record<string, string> = {
    success: 'border-green-500',
    error: 'border-red-500',
    info: 'border-blue-500',
  }
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`bg-dark-800 border-l-4 ${borderColor[t.type]} rounded-lg px-4 py-3 shadow-xl flex items-start gap-3`}
          style={{ animation: 'fadeSlideIn 0.3s ease-out' }}
        >
          <span className="text-sm text-dark-200 flex-1">{t.message}</span>
          <button onClick={() => onDismiss(t.id)} className="text-dark-500 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

/* ================================================================== */
/*  Main Component                                                     */
/* ================================================================== */

export default function AgentStatusPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const navigate = useNavigate()
  const scriptLogsEndRef = useRef<HTMLDivElement>(null)
  const llmLogsEndRef = useRef<HTMLDivElement>(null)
  const consecutiveErrorsRef = useRef(0)

  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [logs, setLogs] = useState<AgentLog[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set())
  const [isGeneratingReport, setIsGeneratingReport] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Toast state
  const [toasts, setToasts] = useState<Toast[]>([])
  const [connectionLost, setConnectionLost] = useState(false)

  // Custom prompt state
  const [customPrompt, setCustomPrompt] = useState('')
  const [isSubmittingPrompt, setIsSubmittingPrompt] = useState(false)

  // Phase skip state
  const [skipConfirm, setSkipConfirm] = useState<string | null>(null)
  const [isSkipping, setIsSkipping] = useState(false)
  const [skippedPhases, setSkippedPhases] = useState<Set<string>>(new Set())

  // AI report state
  const [isGeneratingAiReport, setIsGeneratingAiReport] = useState(false)

  /* ── Toast helpers ──────────────────────────────────────────── */

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = ++_toastSeq
    setToasts(prev => [...prev.slice(-4), { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  /* ── Derived log streams (memoized) ────────────────────────── */

  const scriptLogs = useMemo(
    () => logs.filter(l => l.source === 'script' || (!l.source && !l.message.includes('[LLM]') && !l.message.includes('[AI]'))),
    [logs]
  )

  const llmLogs = useMemo(
    () => logs.filter(l => l.source === 'llm' || l.message.includes('[LLM]') || l.message.includes('[AI]')),
    [logs]
  )

  /* ── Severity counts (memoized) ────────────────────────────── */

  const severityCounts = useMemo(() => {
    if (!status) return { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const f of status.findings) {
      if (f.severity in counts) counts[f.severity]++
    }
    return counts
  }, [status])

  /* ── Data fetch ────────────────────────────────────────────── */

  const fetchStatus = useCallback(async () => {
    if (!agentId) return
    try {
      const [statusData, logsData] = await Promise.all([
        agentApi.getStatus(agentId),
        agentApi.getLogs(agentId, 500),
      ])
      setStatus(statusData)
      setLogs(logsData.logs)
      setError(null)

      if (consecutiveErrorsRef.current >= 3) {
        setConnectionLost(false)
        addToast('Connection restored', 'success')
      }
      consecutiveErrorsRef.current = 0
    } catch (err: unknown) {
      const apiErr = err as { response?: { status?: number } }
      if (apiErr.response?.status === 404) {
        setError('Agent not found')
      } else {
        console.error('Failed to fetch agent status:', err)
        consecutiveErrorsRef.current++
        if (consecutiveErrorsRef.current >= 3) setConnectionLost(true)
      }
    } finally {
      setIsLoading(false)
    }
  }, [agentId, addToast])

  // Poll for status updates
  useEffect(() => {
    if (!agentId) return

    fetchStatus()

    const interval = setInterval(() => {
      if (status?.status === 'running' || status?.status === 'paused') {
        fetchStatus()
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [agentId, status?.status, fetchStatus])

  // Auto-scroll logs
  useEffect(() => {
    if (autoScroll) {
      scriptLogsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      llmLogsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll])

  // Track skipped phases from status updates
  useEffect(() => {
    if (!status) return
    const phase = status.phase.toLowerCase()
    if (phase.includes('_skipped')) {
      const skippedKey = phase.replace('_skipped', '')
      setSkippedPhases(prev => new Set(prev).add(skippedKey))
    }
  }, [status?.phase])

  /* ── Handlers ──────────────────────────────────────────────── */

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await fetchStatus()
    setRefreshing(false)
    addToast('Status refreshed', 'info')
  }, [fetchStatus, addToast])

  const toggleFinding = useCallback((id: string) => {
    setExpandedFindings(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
    addToast('Copied to clipboard', 'success')
  }, [addToast])

  /* ── Report generation ──────────────────────────────────────── */

  const generateReportData = useCallback(() => {
    if (!status) return null

    const severityBreakdown: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const f of status.findings) {
      if (f.severity in severityBreakdown) severityBreakdown[f.severity]++
    }

    return {
      report_info: {
        agent_id: agentId,
        target: status.target,
        mode: status.mode,
        status: status.status,
        started_at: status.started_at,
        completed_at: status.completed_at || new Date().toISOString(),
        total_findings: status.findings.length,
        severity_breakdown: severityBreakdown,
      },
      findings: status.findings.map(f => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        type: f.vulnerability_type,
        cvss_score: f.cvss_score,
        cvss_vector: f.cvss_vector,
        cwe_id: f.cwe_id,
        affected_endpoint: f.affected_endpoint,
        parameter: f.parameter,
        payload: f.payload,
        evidence: f.evidence,
        request: f.request,
        response: f.response,
        description: f.description,
        impact: f.impact,
        poc_code: f.poc_code,
        remediation: f.remediation,
        references: f.references,
        ai_verified: f.ai_verified,
        confidence: f.confidence,
      })),
      logs: logs.slice(-100),
    }
  }, [status, agentId, logs])

  const generateHTMLReport = useCallback(() => {
    if (!status) return ''

    const severityColors: Record<string, string> = {
      critical: '#dc2626',
      high: '#ea580c',
      medium: '#ca8a04',
      low: '#2563eb',
      info: '#6b7280',
    }

    const owaspMap: Record<string, string> = {
      'sql injection': 'A03:2021 - Injection',
      'sqli': 'A03:2021 - Injection',
      'xss': 'A03:2021 - Injection',
      'cross-site scripting': 'A03:2021 - Injection',
      'command injection': 'A03:2021 - Injection',
      'ssrf': 'A10:2021 - Server-Side Request Forgery',
      'idor': 'A01:2021 - Broken Access Control',
      'broken access': 'A01:2021 - Broken Access Control',
      'auth': 'A07:2021 - Identification and Authentication Failures',
      'csrf': 'A01:2021 - Broken Access Control',
      'crypto': 'A02:2021 - Cryptographic Failures',
      'config': 'A05:2021 - Security Misconfiguration',
      'header': 'A05:2021 - Security Misconfiguration',
      'cors': 'A05:2021 - Security Misconfiguration',
      'clickjacking': 'A05:2021 - Security Misconfiguration',
    }

    const getOwasp = (title: string, type: string): string => {
      const searchText = (title + ' ' + type).toLowerCase()
      for (const [key, value] of Object.entries(owaspMap)) {
        if (searchText.includes(key)) return value
      }
      return ''
    }

    const sCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const f of status.findings) {
      if (f.severity in sCounts) sCounts[f.severity]++
    }

    const riskScore = Math.min(100, sCounts.critical * 25 + sCounts.high * 15 + sCounts.medium * 8 + sCounts.low * 3)
    const riskLevel = riskScore >= 75 ? 'Critical' : riskScore >= 50 ? 'High' : riskScore >= 25 ? 'Medium' : 'Low'
    const riskColor = riskScore >= 75 ? '#dc2626' : riskScore >= 50 ? '#ea580c' : riskScore >= 25 ? '#ca8a04' : '#22c55e'

    const findingsHtml = status.findings.map((f, idx) => {
      const owasp = getOwasp(f.title, f.vulnerability_type)
      const cweLink = f.cwe_id ? `https://cwe.mitre.org/data/definitions/${f.cwe_id.replace('CWE-', '')}.html` : ''

      return `
      <div style="background: #1e293b; border: 1px solid #334155; border-left: 4px solid ${severityColors[f.severity]}; border-radius: 8px; margin-bottom: 24px; overflow: hidden; page-break-inside: avoid;">
        <div style="padding: 20px; display: flex; justify-content: space-between; align-items: flex-start; background: linear-gradient(135deg, ${severityColors[f.severity]}10 0%, transparent 100%);">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
              <span style="background: ${severityColors[f.severity]}; color: white; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase;">
                ${f.severity}
              </span>
              <span style="color: #64748b; font-size: 12px;">Finding #${idx + 1}</span>
            </div>
            <h3 style="margin: 0 0 8px 0; color: white; font-size: 18px; font-weight: 600;">${f.title}</h3>
            <p style="margin: 0; color: #94a3b8; font-size: 13px; font-family: monospace;">${f.affected_endpoint}</p>
          </div>
        </div>

        <div style="padding: 20px; border-top: 1px solid #334155;">
          <!-- Technical Metrics -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; padding: 16px; background: #0f172a; border-radius: 8px; margin-bottom: 20px;">
            ${f.cvss_score ? `
            <div>
              <div style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">CVSS 3.1 Score</div>
              <div style="display: flex; align-items: baseline; gap: 8px;">
                <span style="font-size: 28px; font-weight: 700; color: ${severityColors[f.severity]};">${f.cvss_score}</span>
                <span style="font-size: 12px; color: #94a3b8;">${f.cvss_score >= 9 ? 'Critical' : f.cvss_score >= 7 ? 'High' : f.cvss_score >= 4 ? 'Medium' : 'Low'}</span>
              </div>
              ${f.cvss_vector ? `<div style="font-size: 10px; color: #475569; font-family: monospace; margin-top: 4px;">${f.cvss_vector}</div>` : ''}
            </div>
            ` : ''}
            ${f.cwe_id ? `
            <div>
              <div style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">CWE Reference</div>
              <a href="${cweLink}" target="_blank" style="color: #60a5fa; text-decoration: none; font-size: 14px; font-weight: 500;">${f.cwe_id}</a>
            </div>
            ` : ''}
            ${owasp ? `
            <div>
              <div style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">OWASP Top 10</div>
              <div style="color: #fbbf24; font-size: 13px; font-weight: 500;">${owasp}</div>
            </div>
            ` : ''}
            <div>
              <div style="color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Vulnerability Type</div>
              <div style="color: white; font-size: 14px;">${f.vulnerability_type}</div>
            </div>
          </div>

          <!-- Description -->
          ${f.description ? `
          <div style="margin-bottom: 20px;">
            <h4 style="color: #e2e8f0; font-size: 13px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Description</h4>
            <p style="color: #cbd5e1; margin: 0; line-height: 1.7; font-size: 14px;">${f.description}</p>
          </div>
          ` : ''}

          <!-- Affected Endpoint -->
          <div style="margin-bottom: 20px;">
            <h4 style="color: #e2e8f0; font-size: 13px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Affected Endpoint</h4>
            <div style="background: #0f172a; padding: 12px 16px; border-radius: 6px; font-family: monospace; font-size: 13px; color: #38bdf8; overflow-x: auto;">${f.affected_endpoint}</div>
          </div>

          <!-- Evidence -->
          ${f.evidence ? `
          <div style="margin-bottom: 20px;">
            <h4 style="color: #e2e8f0; font-size: 13px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Evidence / Proof of Concept</h4>
            <pre style="background: #0f172a; padding: 16px; border-radius: 6px; color: #fbbf24; margin: 0; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;">${f.evidence}</pre>
          </div>
          ` : ''}

          <!-- Impact -->
          ${f.impact ? `
          <div style="margin-bottom: 20px;">
            <h4 style="color: #e2e8f0; font-size: 13px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Impact</h4>
            <p style="color: #cbd5e1; margin: 0; line-height: 1.7; font-size: 14px;">${f.impact}</p>
          </div>
          ` : ''}

          <!-- Remediation -->
          ${f.remediation ? `
          <div style="background: linear-gradient(135deg, #16a34a15 0%, #16a34a05 100%); border: 1px solid #16a34a40; border-radius: 8px; padding: 16px;">
            <h4 style="color: #4ade80; font-size: 13px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Remediation</h4>
            <p style="color: #cbd5e1; margin: 0; line-height: 1.7; font-size: 14px;">${f.remediation}</p>
          </div>
          ` : ''}

          <!-- References -->
          ${f.references && f.references.length > 0 ? `
          <div style="margin-top: 20px;">
            <h4 style="color: #e2e8f0; font-size: 13px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">References</h4>
            <ul style="margin: 0; padding-left: 20px; color: #94a3b8; font-size: 13px;">
              ${f.references.map(ref => `<li style="margin-bottom: 4px;"><a href="${ref}" target="_blank" style="color: #60a5fa; text-decoration: none;">${ref}</a></li>`).join('')}
            </ul>
          </div>
          ` : ''}
        </div>
      </div>
    `
    }).join('')

    const execSummary = `
    <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border: 1px solid #334155; border-radius: 12px; padding: 24px; margin-bottom: 40px;">
      <h2 style="color: white; margin: 0 0 16px; font-size: 20px; border: none; padding: 0;">Executive Summary</h2>
      <p style="color: #cbd5e1; line-height: 1.8; margin: 0 0 20px;">
        This security assessment of <strong style="color: white;">${status.target}</strong> was conducted using NeuroSploit AI-powered penetration testing platform.
        The assessment identified <strong style="color: white;">${status.findings.length} security findings</strong> across various severity levels.
        ${sCounts.critical > 0 ? `<span style="color: #dc2626; font-weight: 600;">${sCounts.critical} critical vulnerabilities require immediate attention.</span>` : ''}
        ${sCounts.high > 0 ? `<span style="color: #ea580c;">${sCounts.high} high-severity issues should be addressed promptly.</span>` : ''}
      </p>
      <div style="display: flex; align-items: center; gap: 16px; padding: 16px; background: #0f172a; border-radius: 8px;">
        <div>
          <div style="color: #64748b; font-size: 12px; text-transform: uppercase; margin-bottom: 4px;">Overall Risk Score</div>
          <div style="font-size: 32px; font-weight: 700; color: ${riskColor};">${riskScore}/100</div>
        </div>
        <div style="flex: 1;">
          <div style="height: 12px; background: #1e293b; border-radius: 6px; overflow: hidden;">
            <div style="height: 100%; width: ${riskScore}%; background: ${riskColor}; border-radius: 6px;"></div>
          </div>
          <div style="color: ${riskColor}; font-size: 14px; font-weight: 600; margin-top: 8px;">${riskLevel} Risk</div>
        </div>
      </div>
    </div>
    `

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NeuroSploit Security Report - ${agentId}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 40px; line-height: 1.6; }
    .container { max-width: 1000px; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 40px; padding-bottom: 40px; border-bottom: 1px solid #334155; }
    .header h1 { color: white; margin: 0 0 8px; font-size: 28px; }
    .header p { color: #94a3b8; margin: 0; font-size: 14px; }
    .stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 40px; }
    .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-value { font-size: 28px; font-weight: bold; margin-bottom: 4px; }
    .stat-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    h2 { color: white; border-bottom: 1px solid #334155; padding-bottom: 12px; font-size: 18px; }
    .footer { text-align: center; margin-top: 40px; padding-top: 40px; border-top: 1px solid #334155; color: #64748b; font-size: 12px; }
    @media print {
      body { background: white; color: black; padding: 20px; }
      .stat-card, .findings > div { border-color: #ddd; background: #f9f9f9; }
      .header, .footer { border-color: #ddd; }
    }
    @media (max-width: 768px) {
      .stats { grid-template-columns: repeat(3, 1fr); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>NeuroSploit Security Assessment Report</h1>
      <p>Target: ${status.target} | Agent ID: ${agentId} | Mode: ${MODE_LABELS[status.mode] || status.mode}</p>
      <p>Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>

    ${execSummary}

    <div class="stats">
      <div class="stat-card"><div class="stat-value" style="color: white;">${status.findings.length}</div><div class="stat-label">Total</div></div>
      <div class="stat-card"><div class="stat-value" style="color: #dc2626;">${sCounts.critical}</div><div class="stat-label">Critical</div></div>
      <div class="stat-card"><div class="stat-value" style="color: #ea580c;">${sCounts.high}</div><div class="stat-label">High</div></div>
      <div class="stat-card"><div class="stat-value" style="color: #ca8a04;">${sCounts.medium}</div><div class="stat-label">Medium</div></div>
      <div class="stat-card"><div class="stat-value" style="color: #2563eb;">${sCounts.low}</div><div class="stat-label">Low</div></div>
      <div class="stat-card"><div class="stat-value" style="color: #6b7280;">${sCounts.info}</div><div class="stat-label">Info</div></div>
    </div>

    <h2>Detailed Findings</h2>
    <div class="findings">
      ${findingsHtml || '<p style="text-align: center; color: #94a3b8; padding: 40px;">No vulnerabilities identified during this assessment.</p>'}
    </div>

    <div class="footer">
      <p><strong>Generated by NeuroSploit v3.0 AI Security Scanner</strong></p>
      <p>Report generated: ${new Date().toISOString()}</p>
      <p style="margin-top: 16px; font-size: 11px;">This report is confidential and intended for authorized personnel only.</p>
    </div>
  </div>
</body>
</html>`
  }, [status, agentId])

  const handleGenerateReport = useCallback(async (format: 'json' | 'html' = 'json') => {
    if (!agentId || !status) return
    setIsGeneratingReport(true)
    try {
      if (format === 'html') {
        const htmlContent = generateHTMLReport()
        const blob = new Blob([htmlContent], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `neurosploit-report-${agentId}-${new Date().toISOString().split('T')[0]}.html`
        a.click()
        URL.revokeObjectURL(url)
        addToast('HTML report downloaded', 'success')
      } else {
        const reportData = status.report || generateReportData()
        const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `neurosploit-report-${agentId}-${new Date().toISOString().split('T')[0]}.json`
        a.click()
        URL.revokeObjectURL(url)
        addToast('JSON report downloaded', 'success')
      }
    } finally {
      setIsGeneratingReport(false)
    }
  }, [agentId, status, generateHTMLReport, generateReportData, addToast])

  const handleGenerateAiReport = useCallback(async () => {
    if (!status?.scan_id) return
    setIsGeneratingAiReport(true)
    try {
      const report = await reportsApi.generateAiReport({
        scan_id: status.scan_id,
        title: `AI Report - ${status.target || 'Agent Scan'}`,
      })
      window.open(reportsApi.getViewUrl(report.id), '_blank')
      addToast('AI report generated successfully', 'success')
    } catch (err) {
      console.error('Failed to generate AI report:', err)
      addToast('Failed to generate AI report', 'error')
    } finally {
      setIsGeneratingAiReport(false)
    }
  }, [status, addToast])

  /* ── Scan controls ──────────────────────────────────────────── */

  const handleStopScan = useCallback(async () => {
    if (!agentId) return
    setIsStopping(true)
    try {
      await agentApi.stop(agentId)
      const statusData = await agentApi.getStatus(agentId)
      setStatus(statusData)
      addToast('Agent stopped', 'info')
    } catch (err) {
      console.error('Failed to stop agent:', err)
      addToast('Failed to stop agent', 'error')
    } finally {
      setIsStopping(false)
    }
  }, [agentId, addToast])

  const handlePauseScan = useCallback(async () => {
    if (!agentId) return
    try {
      await agentApi.pause(agentId)
      const statusData = await agentApi.getStatus(agentId)
      setStatus(statusData)
      addToast('Agent paused', 'info')
    } catch (err) {
      console.error('Failed to pause agent:', err)
      addToast('Failed to pause agent', 'error')
    }
  }, [agentId, addToast])

  const handleResumeScan = useCallback(async () => {
    if (!agentId) return
    try {
      await agentApi.resume(agentId)
      const statusData = await agentApi.getStatus(agentId)
      setStatus(statusData)
      addToast('Agent resumed', 'success')
    } catch (err) {
      console.error('Failed to resume agent:', err)
      addToast('Failed to resume agent', 'error')
    }
  }, [agentId, addToast])

  /* ── Custom prompt ──────────────────────────────────────────── */

  const handleSubmitPrompt = useCallback(async () => {
    if (!customPrompt.trim() || !agentId) return
    setIsSubmittingPrompt(true)
    const sentPrompt = customPrompt
    try {
      await agentApi.sendPrompt(agentId, customPrompt)
      setCustomPrompt('')
      addToast(`Prompt sent: "${sentPrompt.slice(0, 50)}${sentPrompt.length > 50 ? '...' : ''}"`, 'success')

      const [statusData, logsData] = await Promise.all([
        agentApi.getStatus(agentId),
        agentApi.getLogs(agentId, 200),
      ])
      setStatus(statusData)
      setLogs(logsData.logs || [])
    } catch (err) {
      console.error('Failed to send prompt:', err)
      addToast('Failed to send prompt', 'error')
    } finally {
      setIsSubmittingPrompt(false)
    }
  }, [customPrompt, agentId, addToast])

  /* ── Phase skip ─────────────────────────────────────────────── */

  const handleSkipToPhase = useCallback(async (targetPhase: string) => {
    if (!agentId) return
    setIsSkipping(true)
    try {
      await agentApi.skipToPhase(agentId, targetPhase)
      const currentIndex = status ? getPhaseIndex(status.phase) : 0
      const targetIndex = SCAN_PHASES.findIndex(p => p.key === targetPhase)
      const newSkipped = new Set(skippedPhases)
      for (let i = currentIndex; i < targetIndex; i++) {
        newSkipped.add(SCAN_PHASES[i].key)
      }
      setSkippedPhases(newSkipped)
      setSkipConfirm(null)
      addToast(`Skipped to ${targetPhase}`, 'info')
    } catch (err) {
      console.error('Failed to skip phase:', err)
      addToast('Failed to skip phase', 'error')
    } finally {
      setIsSkipping(false)
    }
  }, [agentId, status, skippedPhases, addToast])

  /* ── Sub-renderers ──────────────────────────────────────────── */

  const renderFindingDetails = useCallback((finding: AgentFinding) => (
    <div className="p-4 pt-0 space-y-4 border-t border-dark-700">
      {/* CVSS & Meta Info */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-dark-400">CVSS:</span>
          <span className={`font-bold ${
            finding.cvss_score >= 9 ? 'text-red-500' :
            finding.cvss_score >= 7 ? 'text-orange-500' :
            finding.cvss_score >= 4 ? 'text-yellow-500' :
            'text-blue-500'
          }`}>
            {finding.cvss_score?.toFixed(1) || 'N/A'}
          </span>
        </div>
        {finding.cwe_id && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-dark-400">CWE:</span>
            <a
              href={`https://cwe.mitre.org/data/definitions/${finding.cwe_id.replace('CWE-', '')}.html`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-400 hover:underline flex items-center gap-1"
            >
              {finding.cwe_id}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
        <span className="text-xs bg-dark-700 px-2 py-1 rounded text-dark-300">
          {finding.vulnerability_type}
        </span>
        {finding.confidence && (
          <span className={`text-xs px-2 py-1 rounded ${
            finding.confidence === 'high' ? 'bg-green-500/20 text-green-400' :
            finding.confidence === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
            'bg-red-500/20 text-red-400'
          }`}>
            {finding.confidence} confidence
          </span>
        )}
        {typeof finding.confidence_score === 'number' && (
          <span className={`text-xs px-2 py-1 rounded border font-medium tabular-nums ${
            finding.confidence_score >= 90 ? 'bg-green-500/15 text-green-400 border-green-500/30' :
            finding.confidence_score >= 60 ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' :
            'bg-red-500/15 text-red-400 border-red-500/30'
          }`}>
            {finding.confidence_score}/100
          </span>
        )}
      </div>

      {/* CVSS Vector */}
      {finding.cvss_vector && (
        <div className="text-xs bg-dark-800 p-2 rounded font-mono text-dark-300">
          {finding.cvss_vector}
        </div>
      )}

      {/* Technical Details Section */}
      <div className="bg-dark-800/50 rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-medium text-primary-400 flex items-center gap-2">
          <Code className="w-4 h-4" />
          Technical Details
        </h4>

        {/* Affected Endpoint */}
        <div>
          <span className="text-xs text-dark-500">Endpoint:</span>
          <div className="flex items-center gap-2 mt-1">
            <Globe className="w-4 h-4 text-dark-400 flex-shrink-0" />
            <code className="text-sm text-blue-400 bg-dark-900 px-2 py-1 rounded break-all">
              {finding.affected_endpoint}
            </code>
          </div>
        </div>

        {/* Parameter */}
        {finding.parameter && (
          <div>
            <span className="text-xs text-dark-500">Vulnerable Parameter:</span>
            <code className="block mt-1 text-sm text-yellow-400 bg-dark-900 px-2 py-1 rounded">
              {finding.parameter}
            </code>
          </div>
        )}

        {/* Payload */}
        {finding.payload && (
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-dark-500">Payload Used:</span>
              <Button variant="ghost" size="sm" onClick={() => copyToClipboard(finding.payload!)}>
                <Copy className="w-3 h-3" />
              </Button>
            </div>
            <code className="block mt-1 text-sm text-red-400 bg-dark-900 px-2 py-1 rounded break-all">
              {finding.payload}
            </code>
          </div>
        )}

        {/* HTTP Request */}
        {finding.request && (
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-dark-500">HTTP Request:</span>
              <Button variant="ghost" size="sm" onClick={() => copyToClipboard(finding.request!)}>
                <Copy className="w-3 h-3" />
              </Button>
            </div>
            <pre className="mt-1 text-xs text-green-400 bg-dark-900 p-2 rounded overflow-x-auto max-h-32">
              {finding.request}
            </pre>
          </div>
        )}

        {/* HTTP Response */}
        {finding.response && (
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-dark-500">HTTP Response (excerpt):</span>
              <Button variant="ghost" size="sm" onClick={() => copyToClipboard(finding.response!)}>
                <Copy className="w-3 h-3" />
              </Button>
            </div>
            <pre className="mt-1 text-xs text-orange-400 bg-dark-900 p-2 rounded overflow-x-auto max-h-32">
              {finding.response}
            </pre>
          </div>
        )}

        {/* Evidence */}
        {finding.evidence && (
          <div>
            <span className="text-xs text-dark-500">Evidence:</span>
            <p className="mt-1 text-sm text-dark-300 bg-dark-900 p-2 rounded">
              {finding.evidence}
            </p>
          </div>
        )}
      </div>

      {/* Description */}
      {finding.description && (
        <div>
          <p className="text-sm font-medium text-dark-300 mb-1">Description</p>
          <p className="text-sm text-dark-400">{finding.description}</p>
        </div>
      )}

      {/* Impact */}
      {finding.impact && (
        <div>
          <p className="text-sm font-medium text-dark-300 mb-1">Impact</p>
          <p className="text-sm text-dark-400">{finding.impact}</p>
        </div>
      )}

      {/* PoC Code */}
      {finding.poc_code && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-medium text-dark-300">Proof of Concept</p>
            <Button variant="ghost" size="sm" onClick={() => copyToClipboard(finding.poc_code)}>
              <Copy className="w-3 h-3 mr-1" />
              Copy
            </Button>
          </div>
          <pre className="text-xs bg-dark-800 p-3 rounded overflow-x-auto text-dark-300 font-mono">
            {finding.poc_code}
          </pre>
        </div>
      )}

      {/* Remediation */}
      {finding.remediation && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3">
          <p className="text-sm font-medium text-green-400 mb-1">Remediation</p>
          <p className="text-sm text-dark-400">{finding.remediation}</p>
        </div>
      )}

      {/* Confidence Breakdown */}
      {finding.confidence_breakdown && Object.keys(finding.confidence_breakdown).length > 0 && (
        <div className="bg-dark-800/50 rounded-lg p-3">
          <p className="text-sm font-medium text-dark-300 mb-2">Confidence Breakdown</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(finding.confidence_breakdown).map(([key, val]) => (
              <div key={key} className="flex items-center justify-between text-xs bg-dark-900 px-2 py-1.5 rounded">
                <span className="text-dark-400 truncate mr-2">{key.replace(/_/g, ' ')}</span>
                <span className={`font-medium tabular-nums ${
                  val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-dark-500'
                }`}>
                  {val > 0 ? '+' : ''}{val}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Proof of Execution */}
      {finding.proof_of_execution && (
        <div className="bg-dark-800/50 rounded-lg p-3">
          <p className="text-sm font-medium text-dark-300 mb-1">Proof of Execution</p>
          <p className="text-xs text-dark-400 whitespace-pre-wrap">{finding.proof_of_execution}</p>
        </div>
      )}

      {/* References */}
      {finding.references && finding.references.length > 0 && (
        <div>
          <p className="text-sm font-medium text-dark-300 mb-1">References</p>
          <div className="flex flex-wrap gap-2">
            {finding.references.map((ref, i) => (
              <a
                key={i}
                href={ref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary-400 hover:underline flex items-center gap-1 bg-dark-800 px-2 py-1 rounded"
              >
                {(() => {
                  try {
                    return new URL(ref).hostname
                  } catch {
                    return ref
                  }
                })()}
                <ExternalLink className="w-3 h-3" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  ), [copyToClipboard])

  const renderLogViewer = useCallback((
    logsToShow: AgentLog[],
    endRef: React.RefObject<HTMLDivElement>,
    title: string,
    icon: React.ReactNode,
  ) => (
    <div className="space-y-1 max-h-[400px] overflow-auto font-mono text-xs">
      {logsToShow.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Terminal className="w-8 h-8 text-dark-600 mb-2" />
          <p className="text-dark-400 text-center text-sm">No {title.toLowerCase()} activity yet...</p>
        </div>
      ) : (
        logsToShow.map((log, i) => {
          const isUserPrompt = log.message.includes('[USER PROMPT]')
          const isAIResponse = log.message.includes('[AI RESPONSE]') || log.message.includes('[AI]')

          return (
            <div
              key={i}
              className={`flex gap-2 py-1 px-1 rounded ${
                isUserPrompt ? 'bg-blue-500/10 border-l-2 border-blue-500' :
                isAIResponse && log.message.includes('[AI RESPONSE]') ? 'bg-purple-500/10 border-l-2 border-purple-500' :
                'hover:bg-dark-800/30'
              }`}
            >
              <span className="text-dark-500 flex-shrink-0 w-20">
                {new Date(log.time).toLocaleTimeString()}
              </span>
              <span className="flex-shrink-0">
                {isUserPrompt ? <Send className="w-3 h-3 text-blue-400" /> :
                 isAIResponse ? <Brain className="w-3 h-3 text-purple-400" /> :
                 icon}
              </span>
              <span className={`break-words ${
                isUserPrompt ? 'text-blue-300 font-medium' :
                isAIResponse && log.message.includes('[AI RESPONSE]') ? 'text-purple-300' :
                log.level === 'error' ? 'text-red-400' :
                log.level === 'warning' ? 'text-yellow-400' :
                log.level === 'success' ? 'text-green-400' :
                log.level === 'llm' ? 'text-purple-400' :
                'text-dark-300'
              }`}>
                {log.message}
              </span>
            </div>
          )
        })
      )}
      <div ref={endRef} />
    </div>
  ), [])

  /* ── Loading state ──────────────────────────────────────────── */

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    )
  }

  /* ── Error state ────────────────────────────────────────────── */

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <XCircle className="w-12 h-12 text-red-500 mb-4" />
        <p className="text-xl text-white mb-2">{error}</p>
        <Button onClick={() => navigate('/scan/new')}>Start New Agent</Button>
      </div>
    )
  }

  if (!status) return null

  /* ── Main render ────────────────────────────────────────────── */

  return (
    <>
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <div className="space-y-6">
        {/* Connection Lost Banner */}
        {connectionLost && (
          <div
            className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-4 py-2.5 flex items-center gap-3"
            style={{ animation: 'fadeSlideIn 0.3s ease-out' }}
          >
            <WifiOff className="w-4 h-4 text-yellow-400 flex-shrink-0" />
            <span className="text-sm text-yellow-300">Connection issues detected. Retrying...</span>
          </div>
        )}

        {/* Header */}
        <div
          className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
          style={{ animation: 'fadeSlideIn 0.3s ease-out' }}
        >
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <Bot className="w-7 h-7 text-primary-500 flex-shrink-0" />
              <span className="truncate">Agent: {agentId}</span>
            </h2>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <span className={`px-3 py-1 rounded-full text-sm font-medium flex items-center gap-1 ${
                status.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                status.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                status.status === 'paused' ? 'bg-yellow-500/20 text-yellow-400' :
                status.status === 'stopped' ? 'bg-orange-500/20 text-orange-400' :
                'bg-red-500/20 text-red-400'
              }`}>
                {PHASE_ICONS[status.status]}
                {status.status.charAt(0).toUpperCase() + status.status.slice(1)}
              </span>
              <span className="text-dark-400 text-sm">Mode: {MODE_LABELS[status.mode] || status.mode}</span>
              {status.task && <span className="text-dark-400 text-sm truncate max-w-xs">Task: {status.task}</span>}
              {status.started_at && (
                <span className="text-dark-500 text-xs">Started {relativeTime(status.started_at)}</span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              className="p-2 rounded-lg bg-dark-800 border border-dark-700 hover:border-dark-600 text-dark-400 hover:text-white transition-all"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            {status.status === 'running' && (
              <>
                <Button variant="secondary" onClick={handlePauseScan}>
                  <Pause className="w-4 h-4 mr-2" />
                  Pause
                </Button>
                <Button variant="danger" onClick={handleStopScan} isLoading={isStopping}>
                  <StopCircle className="w-4 h-4 mr-2" />
                  Stop
                </Button>
              </>
            )}
            {status.status === 'paused' && (
              <>
                <Button variant="primary" onClick={handleResumeScan}>
                  <Play className="w-4 h-4 mr-2" />
                  Resume
                </Button>
                <Button variant="danger" onClick={handleStopScan} isLoading={isStopping}>
                  <StopCircle className="w-4 h-4 mr-2" />
                  Stop
                </Button>
              </>
            )}
            {status.scan_id && (
              <Button variant="secondary" onClick={() => navigate(`/scan/${status.scan_id}`)}>
                <Shield className="w-4 h-4 mr-2" />
                View in Dashboard
              </Button>
            )}
            {/* Always show export if there are findings */}
            {(status.findings.length > 0 || status.report) && (
              <>
                <Button onClick={() => handleGenerateReport('html')} isLoading={isGeneratingReport} variant="primary">
                  <FileText className="w-4 h-4 mr-2" />
                  HTML Report
                </Button>
                <Button onClick={() => handleGenerateReport('json')} isLoading={isGeneratingReport} variant="secondary">
                  <Download className="w-4 h-4 mr-2" />
                  JSON
                </Button>
                {status.scan_id && (
                  <Button onClick={handleGenerateAiReport} isLoading={isGeneratingAiReport} variant="secondary">
                    <Sparkles className="w-4 h-4 mr-2" />
                    AI Report
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Progress with Phase Steps */}
        {(status.status === 'running' || status.status === 'completed' || status.status === 'stopped' || status.status === 'paused') && (
          <Card>
            <div
              className="space-y-4"
              style={{ animation: 'fadeSlideIn 0.3s ease-out 0.05s both' }}
            >
              {/* Phase Steps with Skip */}
              <div className="flex items-center justify-between px-2">
                {SCAN_PHASES.map((phase, index) => {
                  const currentIndex = status.status === 'completed' ? 4 : getPhaseIndex(status.phase)
                  const isActive = index === currentIndex
                  const isCompleted = index < currentIndex || status.status === 'completed'
                  const isStopped = status.status === 'stopped' && index > currentIndex
                  const isSkipped = skippedPhases.has(phase.key)
                  const canSkipTo = (status.status === 'running' || status.status === 'paused') && index > currentIndex && phase.key !== 'completed'

                  return (
                    <div key={phase.key} className="flex flex-col items-center flex-1 relative group">
                      {/* Connector line */}
                      {index > 0 && (
                        <div className={`absolute top-4 right-1/2 w-full h-0.5 -translate-y-1/2 z-0 ${
                          isCompleted || isActive ? 'bg-green-500/50' :
                          isSkipped ? 'bg-yellow-500/30' :
                          'bg-dark-700'
                        }`} />
                      )}

                      {/* Phase node */}
                      <div
                        className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center mb-1 transition-all ${
                          isSkipped ? 'bg-yellow-500/20 text-yellow-500 ring-2 ring-yellow-500/30' :
                          isCompleted ? 'bg-green-500 text-white' :
                          isActive ? 'bg-primary-500 text-white animate-pulse ring-2 ring-primary-500/30' :
                          isStopped ? 'bg-yellow-500/20 text-yellow-500' :
                          canSkipTo ? 'bg-dark-700 text-dark-400 cursor-pointer hover:bg-primary-500/20 hover:text-primary-400 hover:ring-2 hover:ring-primary-500/30' :
                          'bg-dark-700 text-dark-400'
                        }`}
                        onClick={() => canSkipTo && setSkipConfirm(phase.key)}
                      >
                        {isSkipped ? <MinusCircle className="w-4 h-4" /> :
                         isCompleted ? <CheckCircle className="w-4 h-4" /> :
                         isActive ? (PHASE_ICONS[phase.key === 'recon' ? 'reconnaissance' : phase.key] || <span className="text-xs font-bold">{index + 1}</span>) :
                         isStopped ? <StopCircle className="w-4 h-4" /> :
                         canSkipTo ? <SkipForward className="w-3.5 h-3.5" /> :
                         <span className="text-xs font-bold">{index + 1}</span>}
                      </div>

                      <span className={`text-xs text-center ${
                        isSkipped ? 'text-yellow-500' :
                        isCompleted || isActive ? 'text-white' :
                        canSkipTo ? 'text-dark-400 group-hover:text-primary-400' :
                        'text-dark-500'
                      }`}>
                        {isSkipped ? `${phase.label} (skipped)` : phase.label}
                      </span>

                      {/* Skip tooltip on hover */}
                      {canSkipTo && (
                        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-dark-800 text-primary-400 text-[10px] px-2 py-0.5 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-dark-600">
                          Skip to {phase.label}
                        </div>
                      )}

                      {/* Inline skip confirmation */}
                      {skipConfirm === phase.key && (
                        <div className="absolute top-10 left-1/2 -translate-x-1/2 z-20 bg-dark-800 border border-dark-600 rounded-lg p-3 shadow-xl whitespace-nowrap">
                          <p className="text-xs text-dark-300 mb-2">Skip to <span className="text-white font-medium">{phase.label}</span>?</p>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSkipToPhase(phase.key)}
                              disabled={isSkipping}
                              className="px-3 py-1 bg-primary-500 text-white text-xs rounded hover:bg-primary-600 disabled:opacity-50"
                            >
                              {isSkipping ? 'Skipping...' : 'Confirm'}
                            </button>
                            <button
                              onClick={() => setSkipConfirm(null)}
                              className="px-3 py-1 bg-dark-700 text-dark-300 text-xs rounded hover:bg-dark-600"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Progress Bar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-dark-300">
                  {PHASE_ICONS[status.phase.toLowerCase()] || <Clock className="w-4 h-4" />}
                  <span className="capitalize">{status.phase.replace(/_/g, ' ')}</span>
                </div>
                <span className="text-white font-medium tabular-nums">{status.progress}%</span>
              </div>
              <div className="h-2 bg-dark-900 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    status.status === 'completed' ? 'bg-green-500' :
                    status.status === 'stopped' ? 'bg-yellow-500' :
                    'bg-primary-500'
                  }`}
                  style={{ width: `${status.progress}%` }}
                />
              </div>
            </div>
          </Card>
        )}

        {/* Stats */}
        <div
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3"
          style={{ animation: 'fadeSlideIn 0.3s ease-out 0.1s both' }}
        >
          {/* Total */}
          <div className="bg-dark-800 rounded-xl border border-primary-500/20 p-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-white tabular-nums">{status.findings_count}</p>
              <p className="text-[11px] text-dark-400 mt-1">Total Findings</p>
            </div>
          </div>
          {/* Per-severity cards */}
          {SEVERITY_ORDER.map((sev, idx) => {
            const colorClass: Record<Severity, string> = {
              critical: 'text-red-500',
              high: 'text-orange-500',
              medium: 'text-yellow-500',
              low: 'text-blue-500',
              info: 'text-gray-400',
            }
            const borderClass: Record<Severity, string> = {
              critical: 'border-red-500/20',
              high: 'border-orange-500/20',
              medium: 'border-yellow-500/20',
              low: 'border-blue-500/20',
              info: 'border-dark-700',
            }
            return (
              <div
                key={sev}
                className={`bg-dark-800 rounded-xl border ${borderClass[sev]} p-4`}
                style={{ animation: `fadeSlideIn 0.3s ease-out ${0.1 + (idx + 1) * 0.03}s both` }}
              >
                <div className="text-center">
                  <p className={`text-2xl font-bold tabular-nums ${colorClass[sev]}`}>{severityCounts[sev]}</p>
                  <p className="text-[11px] text-dark-400 mt-1 capitalize">{sev}</p>
                </div>
              </div>
            )
          })}
        </div>

        {/* Custom Prompt Input */}
        {status.status === 'running' && (
          <Card>
            <div
              className="space-y-3"
              style={{ animation: 'fadeSlideIn 0.3s ease-out 0.15s both' }}
            >
              <div className="flex items-center gap-2 text-primary-400">
                <Brain className="w-5 h-5" />
                <h3 className="font-medium">Custom AI Prompt</h3>
              </div>
              <p className="text-sm text-dark-400">
                Send a custom instruction to the AI agent. Example: &quot;Test for IDOR on /api/users/[id]&quot; or &quot;Check for XXE in XML endpoints&quot;
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmitPrompt()}
                  placeholder="Enter custom vulnerability test prompt..."
                  className="flex-1 bg-dark-800 border border-dark-600 rounded-lg px-4 py-2 text-white placeholder-dark-400 focus:outline-none focus:border-primary-500 transition-colors"
                />
                <Button
                  onClick={handleSubmitPrompt}
                  isLoading={isSubmittingPrompt}
                  disabled={!customPrompt.trim()}
                >
                  <Send className="w-4 h-4 mr-2" />
                  Send
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Findings */}
        <div style={{ animation: 'fadeSlideIn 0.3s ease-out 0.15s both' }}>
          <Card title="Vulnerabilities Found" subtitle={`${status.findings_count} findings`}>
            <div className="space-y-3 max-h-[600px] overflow-auto">
              {status.findings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <AlertTriangle className="w-12 h-12 text-dark-600 mb-3" />
                  <p className="text-dark-400 text-sm">
                    {status.status === 'running' ? 'Scanning for vulnerabilities...' : 'No vulnerabilities found'}
                  </p>
                  {status.status === 'running' && (
                    <p className="text-dark-500 text-xs mt-1">Findings will appear here as they are discovered</p>
                  )}
                </div>
              ) : (
                status.findings.map((finding) => (
                  <div
                    key={finding.id}
                    className="bg-dark-900/50 rounded-lg border border-dark-700 overflow-hidden"
                  >
                    {/* Finding Header */}
                    <div
                      className="p-4 cursor-pointer hover:bg-dark-800/50 transition-colors"
                      onClick={() => toggleFinding(finding.id)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-2 flex-1 min-w-0">
                          {expandedFindings.has(finding.id) ? (
                            <ChevronDown className="w-4 h-4 mt-1 text-dark-400 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 mt-1 text-dark-400 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-white">{finding.title}</p>
                            <p className="text-sm text-dark-400 truncate">{finding.affected_endpoint}</p>
                            {finding.parameter && (
                              <p className="text-xs text-yellow-400 mt-1">
                                Parameter: <code className="bg-dark-800 px-1 rounded">{finding.parameter}</code>
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <SeverityBadge severity={finding.severity} />
                          {finding.ai_verified && (
                            <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded flex items-center gap-1">
                              <Brain className="w-3 h-3" />
                              AI Verified
                            </span>
                          )}
                          {typeof finding.confidence_score === 'number' && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium tabular-nums ${
                              finding.confidence_score >= 90 ? 'bg-green-500/15 text-green-400 border-green-500/30' :
                              finding.confidence_score >= 60 ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' :
                              'bg-red-500/15 text-red-400 border-red-500/30'
                            }`}>
                              {finding.confidence_score}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Finding Details */}
                    {expandedFindings.has(finding.id) && renderFindingDetails(finding)}
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Split Log Viewers */}
        <div
          className="grid grid-cols-1 lg:grid-cols-2 gap-6"
          style={{ animation: 'fadeSlideIn 0.3s ease-out 0.2s both' }}
        >
          {/* Script Activity Log */}
          <Card
            title={
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-green-400" />
                <span>Script Activity</span>
                <span className="text-xs bg-dark-700 px-2 py-0.5 rounded text-dark-400 tabular-nums">
                  {scriptLogs.length}
                </span>
              </div>
            }
            subtitle="Tool executions, HTTP requests, scanning progress"
          >
            {renderLogViewer(scriptLogs, scriptLogsEndRef, 'Script', <Terminal className="w-3 h-3 text-green-400" />)}
          </Card>

          {/* LLM Activity Log */}
          <Card
            title={
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-purple-400" />
                <span>AI Analysis</span>
                <span className="text-xs bg-dark-700 px-2 py-0.5 rounded text-dark-400 tabular-nums">
                  {llmLogs.length}
                </span>
              </div>
            }
            subtitle="LLM reasoning, vulnerability analysis, decisions"
          >
            {renderLogViewer(llmLogs, llmLogsEndRef, 'AI', <Brain className="w-3 h-3 text-purple-400" />)}
          </Card>
        </div>

        {/* Auto-scroll toggle */}
        <div className="flex justify-end">
          <label className="flex items-center gap-2 text-sm text-dark-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-4 h-4 rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500"
            />
            Auto-scroll logs
          </label>
        </div>

        {/* Report Summary */}
        {(status.status === 'completed' || status.status === 'stopped') && (status.report || status.findings.length > 0) && (() => {
          const reportData = status.report || {
            summary: {
              target: status.target,
              mode: status.mode,
              duration: status.started_at
                ? `${Math.round((new Date(status.completed_at || new Date().toISOString()).getTime() - new Date(status.started_at).getTime()) / 60000)} min`
                : 'N/A',
              total_findings: status.findings.length,
              severity_breakdown: {
                critical: status.findings.filter(f => f.severity === 'critical').length,
                high: status.findings.filter(f => f.severity === 'high').length,
                medium: status.findings.filter(f => f.severity === 'medium').length,
                low: status.findings.filter(f => f.severity === 'low').length,
                info: status.findings.filter(f => f.severity === 'info').length,
              },
            },
            executive_summary: status.status === 'stopped'
              ? `Scan was stopped by user. ${status.findings.length} finding(s) discovered before stopping.`
              : undefined,
            recommendations: [] as string[],
          }

          return (
            <div style={{ animation: 'fadeSlideIn 0.3s ease-out 0.25s both' }}>
              <Card title={status.status === 'stopped' ? 'Partial Report Summary' : 'Report Summary'}>
                <div className="space-y-4">
                  {status.status === 'stopped' && (
                    <div className="flex items-center gap-2 text-yellow-500 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      <span className="text-sm">Scan was stopped - showing partial results</span>
                    </div>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-sm text-dark-400">Target</p>
                      <p className="text-white font-medium truncate" title={reportData.summary.target}>{reportData.summary.target}</p>
                    </div>
                    <div>
                      <p className="text-sm text-dark-400">Mode</p>
                      <p className="text-white font-medium">{MODE_LABELS[reportData.summary.mode] || reportData.summary.mode}</p>
                    </div>
                    <div>
                      <p className="text-sm text-dark-400">Duration</p>
                      <p className="text-white font-medium">{reportData.summary.duration}</p>
                    </div>
                    <div>
                      <p className="text-sm text-dark-400">Total Findings</p>
                      <p className="text-white font-medium tabular-nums">{reportData.summary.total_findings}</p>
                    </div>
                  </div>

                  {reportData.executive_summary && (
                    <div>
                      <p className="text-sm font-medium text-dark-300 mb-2">Executive Summary</p>
                      <p className="text-dark-400 whitespace-pre-wrap">{reportData.executive_summary}</p>
                    </div>
                  )}

                  {reportData.recommendations && reportData.recommendations.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-dark-300 mb-2">Recommendations</p>
                      <ul className="space-y-2">
                        {reportData.recommendations.map((rec: string, i: number) => (
                          <li key={i} className="flex items-start gap-2 text-dark-400">
                            <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                            {rec}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          )
        })()}

        {/* Error Display */}
        {status.error && (
          <div
            className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3"
            style={{ animation: 'fadeSlideIn 0.3s ease-out' }}
          >
            <XCircle className="w-6 h-6 text-red-500 flex-shrink-0" />
            <div>
              <p className="font-medium text-red-400">Agent Error</p>
              <p className="text-sm text-red-300/80 mt-1">{status.error}</p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
