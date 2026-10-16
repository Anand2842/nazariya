import { notFound } from "next/navigation";
import { EnquiryThread } from "@/components/EnquiryThread";
import { getEnquiryThread } from "@/server/enquiries";
import { DomainError } from "@/server/errors";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function RenterEnquiry({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/me/enquiries/${id}`);
  let t;
  try {
    t = await getEnquiryThread(user, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <EnquiryThread
        role={t.role}
        enquiry={JSON.parse(JSON.stringify(t.enquiry))}
        listing={{ title: t.listing.title, slug: t.listing.slug }}
        messages={JSON.parse(JSON.stringify(t.messages))}
        visits={JSON.parse(JSON.stringify(t.visits))}
        outcome={t.outcome}
        counterpart="the lister"
      />
    </div>
  );
}
