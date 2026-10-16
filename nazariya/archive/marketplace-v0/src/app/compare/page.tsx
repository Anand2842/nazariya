import type { Metadata } from "next";
import { CompareClient } from "./CompareClient";
import { searchListings } from "@/server/listings";

export const metadata: Metadata = { title: "Compare" };
export const dynamic = "force-dynamic";

export default async function ComparePage() {
  // The shortlist lives in the browser; we send all public results and the client filters to its shortlist.
  const results = await searchListings({});
  return <CompareClient results={JSON.parse(JSON.stringify(results))} />;
}
