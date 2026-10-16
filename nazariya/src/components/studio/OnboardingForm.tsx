"use client";
import { createWorkspaceAction } from "@/app/actions/studio";
import { Msg, useAction } from "./useAction";

export function OnboardingForm() {
  const { msg, busy, run } = useAction();
  return (
    <form
      className="card space-y-3 p-5"
      data-testid="onboarding-form"
      action={(fd) => void run(() => createWorkspaceAction({ name: String(fd.get("name")), yourName: String(fd.get("yourName")), website: String(fd.get("website") || "") || null }))}
    >
      <div><label className="label" htmlFor="yourName">Your name</label><input id="yourName" name="yourName" className="input" required minLength={2} /></div>
      <div><label className="label" htmlFor="name">Company name</label><input id="name" name="name" className="input" required minLength={2} placeholder="e.g. Skyline Homes" /></div>
      <div><label className="label" htmlFor="website">Company website (optional)</label><input id="website" name="website" className="input" placeholder="skylinehomes.in" /></div>
      <button className="btn-primary w-full" disabled={busy} type="submit" data-testid="onboarding-submit">Create workspace</button>
      <Msg msg={msg} />
    </form>
  );
}
