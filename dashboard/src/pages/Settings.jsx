import { useState, useEffect } from 'react'
import { getYtCookies, saveYtCookies } from '../lib/api.js'
import { useToast } from '../App.jsx'

export default function Settings() {
  const toast = useToast()
  const [cookies, setCookies] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [hasStored, setHasStored] = useState(false)

  useEffect(() => {
    getYtCookies()
      .then(d => {
        setCookies(d.content || '')
        setHasStored(!!(d.content && d.content.trim()))
      })
      .catch(() => toast('Failed to load cookies', false))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      await saveYtCookies(cookies)
      setHasStored(!!(cookies && cookies.trim()))
      toast('Cookies saved')
    } catch (e) {
      toast(e.message || 'Save failed', false)
    } finally {
      setSaving(false)
    }
  }

  async function handleClear() {
    setSaving(true)
    try {
      await saveYtCookies('')
      setCookies('')
      setHasStored(false)
      toast('Cookies cleared')
    } catch (e) {
      toast(e.message || 'Clear failed', false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 4 }}>Settings</h2>
      <p style={{ color: 'var(--muted)', marginBottom: 32, fontSize: 14 }}>
        Manage bot configuration
      </p>

      <div className="card" style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>YouTube Cookies</h3>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
            background: hasStored ? 'rgba(34,197,94,.15)' : 'rgba(148,163,184,.1)',
            color: hasStored ? '#22c55e' : 'var(--muted)',
          }}>
            {hasStored ? 'Active' : 'Not set'}
          </span>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
          Paste Netscape-format cookies exported from a logged-in browser (use a browser extension like
          "Get cookies.txt LOCALLY"). Required for age-restricted or "Sign in to confirm" errors on
          YouTube commands (<code>-yt</code>, <code>-song</code>, <code>-yta</code>).
        </p>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></div>
        ) : (
          <>
            <textarea
              value={cookies}
              onChange={e => setCookies(e.target.value)}
              placeholder={'# Netscape HTTP Cookie File\n# Export from browser using "Get cookies.txt" extension\n\n.youtube.com\tTRUE\t/\tTRUE\t...\t...\t...'}
              spellCheck={false}
              style={{
                width: '100%', minHeight: 320, resize: 'vertical',
                fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5,
                background: 'var(--bg)', color: 'var(--fg)',
                border: '1px solid var(--border)', borderRadius: 8,
                padding: '12px 14px', boxSizing: 'border-box',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                className="btn"
                onClick={handleSave}
                disabled={saving}
                style={{ minWidth: 100 }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {hasStored && (
                <button
                  className="btn"
                  onClick={handleClear}
                  disabled={saving}
                  style={{ background: 'rgba(239,68,68,.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,.3)' }}
                >
                  Clear Cookies
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
