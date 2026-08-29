"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { StaffMember } from "./staff-types";

interface ArchiveStaffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: StaffMember | null;
  onConfirmArchive: () => Promise<void> | void;
}

export function ArchiveStaffDialog({ open, onOpenChange, staff, onConfirmArchive }: ArchiveStaffDialogProps) {
  const [isArchiving, setIsArchiving] = React.useState(false);

  const handleArchive = async () => {
    try {
      setIsArchiving(true);
      await onConfirmArchive();
      onOpenChange(false);
    } catch (error) {
      console.error(error);
    } finally {
      setIsArchiving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Archive staff member</DialogTitle>
          <DialogDescription>
            Archive <span className="font-semibold text-foreground">{staff?.username || "this staff member"}</span>?
            Their Firebase account and staff history remain available, but dashboard access is disabled until an
            administrator reactivates the account.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isArchiving}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={handleArchive} disabled={isArchiving}>
            {isArchiving ? "Archiving..." : "Archive account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
