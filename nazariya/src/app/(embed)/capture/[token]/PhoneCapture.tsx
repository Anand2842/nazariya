"use client";
import { CaptureStudio } from "@/components/capture/CaptureStudio";

export function PhoneCapture(props: { token: string; spaceId: string; spaceName: string; rooms: { id: string; label: string; roomType: string }[]; initialRoomId: string | null }) {
  return (
    <div className="h-dvh">
      <p className="sr-only">Capturing for {props.spaceName}</p>
      <CaptureStudio spaceId={props.spaceId} rooms={props.rooms} initialRoomId={props.initialRoomId} token={props.token} standalone />
    </div>
  );
}
