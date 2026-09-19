import { TIER_NAMES } from '../lib/catalogue'

/**
 * A graded slab, drawn rather than scanned.
 *
 * Card art is generated from the card name so that nothing here reproduces
 * copyrighted artwork - the value on display is the grade, the cert and the
 * vault backing, which is what a graded card is actually traded on.
 */

const GRADE_LABEL: Record<number, string> = {
  10: 'GEM MINT',
  9: 'MINT',
  8: 'NM-MT',
  7: 'NEAR MINT',
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface CardArtProps {
  name: string
  set: string
  tier: number
  grade: number
  serial: number
  vaultRef?: number
  comp?: number
  size?: 'sm' | 'md' | 'lg'
}

export function CardArt({
  name,
  set,
  tier,
  grade,
  serial,
  vaultRef = 0,
  comp,
  size = 'md',
}: CardArtProps) {
  const h = hash(name + set)
  const hue = h % 360
  const hue2 = (hue + 40 + (h % 60)) % 360
  const seed = (h >> 8) % 1000

  const vaulted = vaultRef > 0

  return (
    <div className={`slab slab-${size} tier-${tier}${vaulted ? ' slab-vaulted' : ''}`}>
      <div className="slab-label">
        <div className="slab-grade">
          <span className="slab-grade-num">{grade}</span>
          <span className="slab-grade-text">{GRADE_LABEL[grade] ?? 'GRADED'}</span>
        </div>
        <div className="slab-ident">
          <div className="slab-name">{name}</div>
          <div className="slab-set">{set}</div>
        </div>
      </div>

      <div className="slab-window">
        <svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={`bg-${h}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={`hsl(${hue} 70% 22%)`} />
              <stop offset="100%" stopColor={`hsl(${hue2} 65% 12%)`} />
            </linearGradient>
            <radialGradient id={`orb-${h}`} cx="50%" cy="42%" r="55%">
              <stop offset="0%" stopColor={`hsl(${hue} 95% 72%)`} stopOpacity="0.95" />
              <stop offset="60%" stopColor={`hsl(${hue2} 85% 52%)`} stopOpacity="0.55" />
              <stop offset="100%" stopColor={`hsl(${hue2} 80% 40%)`} stopOpacity="0" />
            </radialGradient>
          </defs>

          <rect width="100" height="140" fill={`url(#bg-${h})`} />

          {Array.from({ length: 7 }, (_, i) => (
            <circle
              key={i}
              cx={50 + Math.sin(seed + i * 1.7) * 22}
              cy={58 + Math.cos(seed + i * 2.3) * 26}
              r={30 - i * 3.4}
              fill="none"
              stroke={`hsl(${(hue + i * 24) % 360} 80% 62%)`}
              strokeOpacity={0.16 + i * 0.045}
              strokeWidth={0.7}
            />
          ))}

          <circle cx="50" cy="58" r="34" fill={`url(#orb-${h})`} />

          {tier >= 3 && (
            <g opacity="0.5">
              {Array.from({ length: 22 }, (_, i) => (
                <rect
                  key={i}
                  x={(i * 4.9 + (seed % 5)) % 100}
                  y="0"
                  width="1.4"
                  height="140"
                  fill={`hsl(${(hue + i * 16) % 360} 92% 68%)`}
                  opacity={0.18}
                />
              ))}
            </g>
          )}

          <text
            x="50"
            y="112"
            textAnchor="middle"
            fill="rgba(255,255,255,0.94)"
            fontSize="9.5"
            fontWeight="800"
            fontFamily="Inter, sans-serif"
            letterSpacing="-0.3"
          >
            {name.length > 13 ? name.slice(0, 12) + '.' : name}
          </text>
          <text
            x="50"
            y="122"
            textAnchor="middle"
            fill="rgba(255,255,255,0.5)"
            fontSize="5"
            fontFamily="JetBrains Mono, monospace"
            letterSpacing="0.6"
          >
            {TIER_NAMES[tier]?.toUpperCase()}
          </text>
        </svg>

        {vaulted && (
          <div className="slab-vault-tag" title={`Vault item #${vaultRef}`}>
            VAULTED
          </div>
        )}
      </div>

      <div className="slab-foot">
        <span className="slab-serial">#{String(serial).padStart(4, '0')}</span>
        {comp !== undefined && <span className="slab-comp">${comp.toLocaleString()}</span>}
      </div>
    </div>
  )
}
