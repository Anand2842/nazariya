export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="#0f766e" />
      <path d="M6 20c3.6-6 8.5-9 14-9s10.4 3 14 9c-3.6 6-8.5 9-14 9S9.6 26 6 20Z" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="20" cy="20" r="5.2" fill="#f59e0b" />
      <circle cx="20" cy="20" r="2.2" fill="#14213d" />
    </svg>
  );
}
