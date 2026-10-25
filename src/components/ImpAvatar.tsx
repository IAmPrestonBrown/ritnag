import type { ImpState } from "../../shared/events";

/** Inline-SVG imp. CSS drives every state; `mouthOpen` toggles during real audio playback. */
export function ImpAvatar({ state, mouthOpen }: { state: ImpState; mouthOpen: boolean }) {
  return (
    <div className={`imp imp--${state}`} aria-label={`Imp is ${state}`}>
      <svg viewBox="0 0 200 220" role="img">
        <g className="imp-tail">
          <path d="M140 170 C 185 175, 190 130, 172 118" fill="none" stroke="var(--imp-skin-dark)" strokeWidth="7" strokeLinecap="round" />
          <path d="M165 110 L 182 112 L 172 126 Z" fill="var(--imp-skin-dark)" />
        </g>
        <g className="imp-body">
          {/* horns */}
          <path d="M62 62 C 50 30, 40 22, 32 18 C 48 40, 50 60, 58 76 Z" fill="var(--imp-horn)" />
          <path d="M138 62 C 150 30, 160 22, 168 18 C 152 40, 150 60, 142 76 Z" fill="var(--imp-horn)" />
          {/* ears */}
          <path d="M42 100 L 18 84 L 46 120 Z" fill="var(--imp-skin-dark)" />
          <path d="M158 100 L 182 84 L 154 120 Z" fill="var(--imp-skin-dark)" />
          {/* body + head */}
          <ellipse cx="100" cy="182" rx="44" ry="30" fill="var(--imp-skin-dark)" />
          <circle cx="100" cy="108" r="62" fill="var(--imp-skin)" />
          {/* brows */}
          <path className="imp-brow imp-brow--l" d="M60 82 L 88 92" stroke="var(--imp-ink)" strokeWidth="6" strokeLinecap="round" />
          <path className="imp-brow imp-brow--r" d="M140 82 L 112 92" stroke="var(--imp-ink)" strokeWidth="6" strokeLinecap="round" />
          {/* eyes */}
          <g className="imp-eyes">
            <ellipse cx="76" cy="106" rx="12" ry="14" fill="#fff" />
            <ellipse cx="124" cy="106" rx="12" ry="14" fill="#fff" />
            <g className="imp-pupils">
              <circle cx="78" cy="108" r="6" fill="var(--imp-ink)" />
              <circle cx="126" cy="108" r="6" fill="var(--imp-ink)" />
            </g>
          </g>
          {/* mouth */}
          {mouthOpen ? (
            <g>
              <ellipse cx="100" cy="142" rx="20" ry="12" fill="var(--imp-ink)" />
              <ellipse cx="100" cy="148" rx="10" ry="5" fill="#e0506a" />
            </g>
          ) : (
            <g>
              <path d="M74 136 Q 100 158, 128 132" fill="none" stroke="var(--imp-ink)" strokeWidth="5" strokeLinecap="round" />
              <path d="M84 140 L 88 148 L 92 142 Z" fill="#fff" />
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}
