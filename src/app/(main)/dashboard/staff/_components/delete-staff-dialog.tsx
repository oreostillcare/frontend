"use client";

import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

import type { StaffMember } from "./staff-types";

interface ArchiveStaffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: StaffMember | null;
  onConfirmArchive: () => Promise<void> | void;
}

export function ArchiveStaffDialog({ open, onOpenChange, staff, onConfirmArchive }: ArchiveStaffDialogProps) {
  const [isArchiving, setIsArchiving] = React.useState(false);

  const handleArchive = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      setIsArchiving(true);
      await onConfirmArchive();
      onOpenChange(false);
    } catch (error) {
      console.error("Unable to archive staff member:", error);
    } finally {
      setIsArchiving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive staff member?</AlertDialogTitle>
          <AlertDialogDescription>
            {staff?.isInvitation ? (
              <>
                Verification for <span className="font-medium text-foreground">{staff.username}</span> will be paused.
                If this unverified account is not restored, it will be permanently deleted after 6 days.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">{staff?.username || "This staff member"}</span> will be
                hidden from the active list and dashboard access will be disabled until an administrator restores the
                account.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isArchiving}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isArchiving} onClick={handleArchive}>
            {isArchiving && <Spinner data-icon="inline-start" />}
            {isArchiving ? "Archiving..." : "Archive account"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface RestoreStaffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: StaffMember | null;
  onConfirmRestore: () => Promise<void> | void;
}

export function RestoreStaffDialog({ open, onOpenChange, staff, onConfirmRestore }: RestoreStaffDialogProps) {
  const [isRestoring, setIsRestoring] = React.useState(false);

  const handleRestore = async () => {
    try {
      setIsRestoring(true);
      await onConfirmRestore();
      onOpenChange(false);
    } catch (error) {
      console.error("Unable to restore staff member:", error);
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Restore staff member</DialogTitle>
          <DialogDescription>
            {staff?.isInvitation ? (
              <>
                Restore <span className="font-medium text-foreground">{staff.username}</span> to the active list? The
                six-day deletion timer will stop. If the verification link expired, resend it afterward.
              </>
            ) : (
              <>
                Restore <span className="font-medium text-foreground">{staff?.username || "this staff member"}</span>?
                Dashboard access will be enabled again with the existing credentials.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isRestoring}>
            Cancel
          </Button>
          <Button type="button" onClick={handleRestore} disabled={isRestoring}>
            {isRestoring && <Spinner data-icon="inline-start" />}
            {isRestoring ? "Restoring..." : "Restore account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CancelInvitationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: StaffMember | null;
  onConfirmCancel: () => Promise<void> | void;
}

export function CancelInvitationDialog({
  open,
  onOpenChange,
  staff,
  onConfirmCancel,
}: CancelInvitationDialogProps) {
  const [isCancelling, setIsCancelling] = React.useState(false);

  const handleCancel = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      setIsCancelling(true);
      await onConfirmCancel();
      onOpenChange(false);
    } catch (error) {
      console.error("Unable to cancel pending invitation:", error);
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel pending invitation?</AlertDialogTitle>
          <AlertDialogDescription>
            The invitation for <span className="font-medium text-foreground">{staff?.email}</span> and its pending
            Firebase account will be permanently removed. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isCancelling}>Keep invitation</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isCancelling} onClick={handleCancel}>
            {isCancelling && <Spinner data-icon="inline-start" />}
            {isCancelling ? "Cancelling..." : "Cancel invitation"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
