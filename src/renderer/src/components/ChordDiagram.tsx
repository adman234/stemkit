import type { GuitarShape } from '../lib/guitar'

interface Props {
  shape: GuitarShape
  color: string
}

const STRINGS = 6
const FRETS = 4
const W = 68
const H = 86
const LEFT = 9
const TOP = 16
const STRING_GAP = (W - LEFT * 2) / (STRINGS - 1)
const FRET_GAP = (H - TOP - 10) / FRETS

/* one guitar chord box: strings run left to right, low E first */
export function ChordDiagram({ shape, color }: Props): React.ReactElement {
  const openFret = shape.baseFret
  const x = (string: number): number => LEFT + string * STRING_GAP
  const y = (fret: number): number => TOP + fret * FRET_GAP

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-[68px] h-[86px]">
      {/* nut, or the fret number when the shape sits higher up the neck */}
      {openFret === 1 ? (
        <rect x={LEFT - 1} y={TOP - 3} width={W - LEFT * 2 + 2} height={3} fill="rgba(255,255,255,0.75)" />
      ) : (
        <text x={2} y={TOP + 8} fontSize="8" fill="rgba(255,255,255,0.5)">
          {openFret}
        </text>
      )}

      {[...Array(FRETS + 1)].map((_, f) => (
        <line
          key={`f${f}`}
          x1={LEFT}
          y1={y(f)}
          x2={W - LEFT}
          y2={y(f)}
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="1"
        />
      ))}
      {[...Array(STRINGS)].map((_, s) => (
        <line
          key={`s${s}`}
          x1={x(s)}
          y1={TOP}
          x2={x(s)}
          y2={y(FRETS)}
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="1"
        />
      ))}

      {shape.barres.map((barre) => {
        const strings = shape.frets
          .map((fret, i) => (fret === barre ? i : -1))
          .filter((i) => i >= 0)
        if (strings.length < 2) return null
        const from = Math.min(...strings)
        const to = Math.max(...strings)
        return (
          <rect
            key={`b${barre}`}
            x={x(from) - 4}
            y={y(barre - openFret + 0.5) - 4}
            width={x(to) - x(from) + 8}
            height={8}
            rx={4}
            fill={color}
          />
        )
      })}

      {shape.frets.map((fret, s) => {
        if (fret === -1) {
          return (
            <text key={`m${s}`} x={x(s)} y={TOP - 5} fontSize="8" textAnchor="middle" fill="rgba(255,255,255,0.4)">
              ×
            </text>
          )
        }
        if (fret === 0) {
          return (
            <circle key={`o${s}`} cx={x(s)} cy={TOP - 7} r={2.6} fill="none" stroke="rgba(255,255,255,0.5)" />
          )
        }
        const finger = shape.fingers[s]
        return (
          <g key={`d${s}`}>
            <circle cx={x(s)} cy={y(fret - openFret + 0.5)} r={4.4} fill={color} />
            {finger > 0 && (
              <text
                x={x(s)}
                y={y(fret - openFret + 0.5) + 2.6}
                fontSize="7"
                textAnchor="middle"
                fill="#0b0b10"
                fontWeight="700"
              >
                {finger}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
