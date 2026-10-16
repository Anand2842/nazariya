"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { OtpLogin } from "@/components/OtpLogin";

function Inner() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return (
    <div className="mx-auto max-w-sm px-4 py-12">
      <h1 className="text-2xl font-extrabold">Log in</h1>
      <p className="muted mt-1 mb-6">One account for renters, listers and owners.</p>
      <div className="card p-5">
        <OtpLogin onDone={() => { router.push(safeNext); router.refresh(); }} />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
