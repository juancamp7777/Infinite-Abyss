/** Arte de Leviathan: tridente dorado sobre el abismo, con olas y fichas flotando. Decorativo. */
export function LeviathanArt({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 240" className={className} aria-hidden focusable="false">
      <defs>
        <radialGradient id="lv-glow" cx="50%" cy="45%" r="55%">
          <stop offset="0" stopColor="#38bdf8" stopOpacity=".55" />
          <stop offset=".55" stopColor="#0ea5e9" stopOpacity=".12" />
          <stop offset="1" stopColor="#0ea5e9" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="lv-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset=".5" stopColor="#f5b83d" />
          <stop offset="1" stopColor="#b7791f" />
        </linearGradient>
        <linearGradient id="lv-wave" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0ea5e9" stopOpacity=".55" />
          <stop offset="1" stopColor="#082f49" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="160" cy="110" r="120" fill="url(#lv-glow)" />
      {/* Tridente */}
      <g fill="url(#lv-gold)" stroke="#7c4a03" strokeWidth="1.5" strokeLinejoin="round">
        <rect x="153" y="78" width="14" height="140" rx="6" />
        <path d="M160 18 l14 34 h-9 v34 h-10 v-34 h-9 z" />
        <path d="M110 44 l10 30 h-6 c0 26 14 38 40 38 v12 c-36 0 -54 -18 -54 -50 h-6 z" />
        <path d="M210 44 l-10 30 h6 c0 26 -14 38 -40 38 v12 c36 0 54 -18 54 -50 h6 z" />
        <rect x="138" y="132" width="44" height="10" rx="5" />
      </g>
      {/* Fichas */}
      {[
        [62, 64, 15],
        [258, 74, 12],
        [238, 150, 17],
        [78, 158, 11],
      ].map(([x, y, r], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <circle r={r} fill="url(#lv-gold)" stroke="#7c4a03" strokeWidth="1.5" />
          <circle r={r * 0.62} fill="none" stroke="#fff7d6" strokeOpacity=".7" strokeDasharray="3 3" />
        </g>
      ))}
      {/* Olas */}
      <path d="M0 196 C40 178 80 214 120 196 S200 178 240 196 S300 214 320 200 V240 H0 Z" fill="url(#lv-wave)" />
      <path d="M0 214 C50 200 90 230 140 214 S230 200 270 214 S310 226 320 220 V240 H0 Z" fill="#0c4a6e" fillOpacity=".55" />
    </svg>
  );
}
