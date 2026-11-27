const OPTIONS = [
  { value: 'day', label: 'Tag', hint: '24 h zurück · 48 h Prognose' },
  { value: 'week', label: 'Woche', hint: '7 Tage zurück · 7 Tage Prognose' },
  { value: 'month', label: 'Monat', hint: '30 Tage zurück · 16 Tage Prognose' },
]

export default function RangeSwitch({ value, onChange }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Zeitraum">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          className={value === o.value ? 'seg active' : 'seg'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
