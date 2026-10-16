"use server";
import { ownerRespond, sendOwnerOtp } from "@/server/trust";
import { act } from "./result";

export async function ownerSendCode(authorizationId: string) {
  return act(async () => {
    const r = await sendOwnerOtp(authorizationId);
    return { devCode: r.devCode };
  });
}

export async function ownerDecide(authorizationId: string, code: string, accept: boolean) {
  return act(async () => {
    await ownerRespond(authorizationId, code, accept);
  });
}
