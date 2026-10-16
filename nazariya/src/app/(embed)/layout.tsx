// Bare layout for embeddable and shareable viewers: no Nazariya chrome, customer branding only.
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh w-full overflow-hidden bg-black">{children}</div>;
}
