import { useState, useRef, useCallback, useEffect } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import './App.css'

GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/pdf.worker.min.mjs'

interface ModelResult {
  content: string
  loading: boolean
  error: string | null
  elapsed: number | null
}

interface ModelInfo {
  id: string
  name: string
}

function getToken(): string {
  return localStorage.getItem('owui_token') ?? ''
}

function setToken(token: string) {
  localStorage.setItem('owui_token', token)
}

function clearToken() {
  localStorage.removeItem('owui_token')
}

function getSelectedModels(): string[] {
  try {
    const stored = localStorage.getItem('owui_selected_models')
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return []
}

function saveSelectedModels(models: string[]) {
  localStorage.setItem('owui_selected_models', JSON.stringify(models))
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch('/api/v1/auths/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sign in failed: ${text}`)
  }
  const data = await res.json()
  return data.token
}

async function fetchModels(token: string): Promise<ModelInfo[]> {
  const res = await fetch('/api/models', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Failed to fetch models')
  const data = await res.json()
  return (data.data ?? data).map((m: { id: string; name?: string }) => ({
    id: m.id,
    name: m.name ?? m.id,
  }))
}

async function chatComplete(
  model: string,
  prompt: string,
  token: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch('/api/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

async function extractPdfImages(file: File): Promise<string[]> {
  const buffer = await file.arrayBuffer()
  const pdf = await getDocument({ data: buffer }).promise
  const images: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport, canvas }).promise
    images.push(canvas.toDataURL('image/png'))
  }
  return images
}

async function chatCompleteWithImages(
  model: string,
  prompt: string,
  imageUrls: string[],
  token: string,
  signal: AbortSignal,
): Promise<string> {
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: prompt },
    ...imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ]
  const res = await fetch('/api/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      stream: false,
    }),
    signal,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function charCount(text: string): number {
  return text.length
}

function ModelPanel({ model, result, name }: { model: string; result: ModelResult; name: string }) {
  return (
    <div className="model-panel">
      <div className="model-header">
        <h2 title={model}>{name}</h2>
        {result.loading && <span className="badge loading">Generating…</span>}
        {!result.loading && result.elapsed !== null && !result.error && (
          <span className="badge done">{(result.elapsed / 1000).toFixed(1)}s</span>
        )}
        {!result.loading && result.error && (
          <span className="badge error-badge">Error</span>
        )}
      </div>
      {result.error ? (
        <div className="error">{result.error}</div>
      ) : (
        <div className="model-content">
          {result.loading ? (
            <div className="generating">
              <div className="spinner" />
              <span>Waiting for response…</span>
            </div>
          ) : result.content ? (
            <>
              <pre>{result.content}</pre>
              <div className="stats">
                <span>{(result.elapsed! / 1000).toFixed(2)}s</span>
                <span>{wordCount(result.content)} words</span>
                <span>{charCount(result.content).toLocaleString()} chars</span>
                <span>~{Math.ceil(charCount(result.content) / 4)} tokens</span>
              </div>
            </>
          ) : (
            <pre className="placeholder">No response yet.</pre>
          )}
        </div>
      )}
    </div>
  )
}

type Tab = 'prompt' | 'pdf'

function App() {
  const [tab, setTab] = useState<Tab>('prompt')
  const [prompt, setPrompt] = useState('')
  const [token, setTokenState] = useState(getToken)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(false)
  const loggedIn = token.length > 0

  const [models, setModels] = useState<ModelInfo[]>([])
  const [selected, setSelected] = useState<string[]>(getSelectedModels)
  const [results, setResults] = useState<Record<string, ModelResult>>({})
  const abortRef = useRef<AbortController | null>(null)
  const anyLoading = Object.values(results).some((r) => r.loading)

  // PDF state
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfImages, setPdfImages] = useState<string[] | null>(null)
  const [pdfExtracting, setPdfExtracting] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [pdfPrompt, setPdfPrompt] = useState('Describe what this document is about. Summarize the key points, structure, and any notable details.')
  const [pdfResults, setPdfResults] = useState<Record<string, ModelResult>>({})
  const pdfAbortRef = useRef<AbortController | null>(null)
  const anyPdfLoading = Object.values(pdfResults).some((r) => r.loading)

  useEffect(() => {
    if (!loggedIn) return
    fetchModels(token).then(setModels).catch(() => {
      clearToken()
      setTokenState('')
    })
  }, [loggedIn, token])

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
      saveSelectedModels(next)
      return next
    })
  }

  // --- Prompt tab logic ---
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!prompt.trim() || selected.length === 0) return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const fresh: Record<string, ModelResult> = {}
      for (const m of selected) {
        fresh[m] = { content: '', loading: true, error: null, elapsed: null }
      }
      setResults(fresh)

      await Promise.allSettled(
        selected.map(async (model) => {
          const start = performance.now()
          try {
            const content = await chatComplete(model, prompt, token, controller.signal)
            const elapsed = performance.now() - start
            setResults((prev) => ({
              ...prev,
              [model]: { content, loading: false, error: null, elapsed },
            }))
          } catch (err) {
            if ((err as Error).name === 'AbortError') return
            const elapsed = performance.now() - start
            setResults((prev) => ({
              ...prev,
              [model]: { content: '', loading: false, error: (err as Error).message, elapsed },
            }))
          }
        }),
      )
    },
    [prompt, token, selected],
  )

  const handleStop = () => {
    abortRef.current?.abort()
    setResults((prev) => {
      const next = { ...prev }
      for (const m of selected) {
        if (next[m]?.loading) {
          next[m] = { ...next[m], loading: false }
        }
      }
      return next
    })
  }

  // --- PDF tab logic ---
  const handlePdfSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPdfFile(file)
    setPdfImages(null)
    setPdfError(null)
    setPdfExtracting(true)
    try {
      const images = await extractPdfImages(file)
      setPdfImages(images)
    } catch (err) {
      setPdfError(`Failed to read PDF: ${(err as Error).message}`)
    } finally {
      setPdfExtracting(false)
    }
  }

  const handlePdfSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!pdfImages || selected.length === 0) return

      pdfAbortRef.current?.abort()
      const controller = new AbortController()
      pdfAbortRef.current = controller

      const fresh: Record<string, ModelResult> = {}
      for (const m of selected) {
        fresh[m] = { content: '', loading: true, error: null, elapsed: null }
      }
      setPdfResults(fresh)

      await Promise.allSettled(
        selected.map(async (model) => {
          const start = performance.now()
          try {
            const content = await chatCompleteWithImages(model, pdfPrompt.trim(), pdfImages, token, controller.signal)
            const elapsed = performance.now() - start
            setPdfResults((prev) => ({
              ...prev,
              [model]: { content, loading: false, error: null, elapsed },
            }))
          } catch (err) {
            if ((err as Error).name === 'AbortError') return
            const elapsed = performance.now() - start
            setPdfResults((prev) => ({
              ...prev,
              [model]: { content: '', loading: false, error: (err as Error).message, elapsed },
            }))
          }
        }),
      )
    },
    [pdfImages, pdfPrompt, token, selected],
  )

  const handlePdfStop = () => {
    pdfAbortRef.current?.abort()
    setPdfResults((prev) => {
      const next = { ...prev }
      for (const m of selected) {
        if (next[m]?.loading) {
          next[m] = { ...next[m], loading: false }
        }
      }
      return next
    })
  }

  // --- Auth ---
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(null)
    setAuthLoading(true)
    try {
      const jwt = await signIn(email, password)
      setToken(jwt)
      setTokenState(jwt)
      setPassword('')
    } catch (err) {
      setAuthError((err as Error).message)
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = () => {
    clearToken()
    setTokenState('')
  }

  const modelMap = Object.fromEntries(models.map((m) => [m.id, m.name]))
  const activeResults = tab === 'prompt' ? results : pdfResults
  const activeLoading = tab === 'prompt' ? anyLoading : anyPdfLoading

  if (!loggedIn) {
    return (
      <div className="app">
        <header>
          <h1>Model Comparison</h1>
        </header>
        <form className="login-form" onSubmit={handleLogin}>
          <h2>Sign in with your Open WebUI account</h2>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
          />
          {authError && <div className="error">{authError}</div>}
          <button type="submit" disabled={authLoading}>
            {authLoading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>Model Comparison</h1>
        <div className="auth-row">
          <span className="logged-in">Signed in</span>
          <button type="button" className="toggle-key" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      <div className="model-selector">
        <h3>Select models to compare:</h3>
        <div className="model-chips">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`chip ${selected.includes(m.id) ? 'selected' : ''}`}
              onClick={() => toggleModel(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
        {models.length === 0 && <span className="hint">Loading models…</span>}
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === 'prompt' ? 'active' : ''}`}
          onClick={() => setTab('prompt')}
        >
          Prompt
        </button>
        <button
          type="button"
          className={`tab ${tab === 'pdf' ? 'active' : ''}`}
          onClick={() => setTab('pdf')}
        >
          PDF Analysis
        </button>
      </div>

      {tab === 'prompt' && (
        <form className="prompt-form" onSubmit={handleSubmit}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter your prompt…"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSubmit(e)
              }
            }}
          />
          <div className="form-actions">
            <button type="submit" disabled={anyLoading || !prompt.trim() || selected.length === 0}>
              Compare {selected.length > 0 && `(${selected.length})`}
            </button>
            {anyLoading && (
              <button type="button" className="stop-btn" onClick={handleStop}>
                Stop
              </button>
            )}
            <span className="hint">Ctrl+Enter to submit</span>
          </div>
        </form>
      )}

      {tab === 'pdf' && (
        <form className="prompt-form" onSubmit={handlePdfSubmit}>
          <div className="pdf-upload-area">
            <label className="pdf-label">
              <input type="file" accept=".pdf" onChange={handlePdfSelect} />
              <span className="pdf-btn">Choose PDF</span>
              {pdfFile && <span className="pdf-filename">{pdfFile.name}</span>}
            </label>
            {pdfExtracting && <span className="hint">Rendering pages…</span>}
            {pdfError && <div className="error">{pdfError}</div>}
            {pdfImages && (
              <div className="pdf-info">
                <span>{pdfImages.length} page{pdfImages.length !== 1 ? 's' : ''} rendered</span>
              </div>
            )}
          </div>
          <textarea
            value={pdfPrompt}
            onChange={(e) => setPdfPrompt(e.target.value)}
            placeholder="Instructions for the models…"
            rows={2}
          />
          <div className="form-actions">
            <button type="submit" disabled={anyPdfLoading || !pdfImages || selected.length === 0}>
              Analyze {selected.length > 0 && `(${selected.length})`}
            </button>
            {anyPdfLoading && (
              <button type="button" className="stop-btn" onClick={handlePdfStop}>
                Stop
              </button>
            )}
          </div>
        </form>
      )}

      {selected.length > 0 && Object.keys(activeResults).length > 0 && (
        <div className="panels" style={{ gridTemplateColumns: `repeat(${Math.min(selected.length, 3)}, 1fr)` }}>
          {selected.map((model) =>
            activeResults[model] ? (
              <ModelPanel key={model} model={model} result={activeResults[model]} name={modelMap[model] ?? model} />
            ) : null,
          )}
        </div>
      )}

      {activeLoading && (
        <div className="global-timer">
          <Timer />
        </div>
      )}
    </div>
  )
}

function Timer() {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(performance.now())

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(performance.now() - startRef.current)
    }, 100)
    return () => clearInterval(id)
  }, [])

  return <span className="hint">Total elapsed: {(elapsed / 1000).toFixed(1)}s</span>
}

export default App
