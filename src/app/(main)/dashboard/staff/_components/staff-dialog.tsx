"use client";

import * as React from "react";

import { CheckCircle2, MailCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

import type { StaffFormData, StaffMember, StaffRole, StaffSaveResult } from "./staff-types";

interface StaffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staffToEdit?: StaffMember | null;
  onSave: (data: StaffFormData) => Promise<StaffSaveResult>;
  onCancelVerification: () => Promise<void>;
  validateNewEmail: (email: string) => string | null;
}

export function StaffDialog({
  open,
  onOpenChange,
  staffToEdit,
  onSave,
  onCancelVerification,
  validateNewEmail,
}: StaffDialogProps) {
  const [role, setRole] = React.useState<StaffRole>("Operator");
  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [isSaving, setIsSaving] = React.useState(false);
  const [isCancellingVerification, setIsCancellingVerification] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState("");
  const [verificationState, setVerificationState] = React.useState<"idle" | "pending" | "completed">("idle");
  const initializedDialog = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      initializedDialog.current = null;
      return;
    }
    const dialogKey = staffToEdit?.id ?? "new-staff";
    if (initializedDialog.current === dialogKey) return;
    initializedDialog.current = dialogKey;
    setRole(staffToEdit?.role ?? "Operator");
    setUsername(staffToEdit?.username ?? "");
    setEmail(staffToEdit?.pendingEmail ?? staffToEdit?.email ?? "");
    setErrorMessage("");
    setIsSaving(false);
    setIsCancellingVerification(false);
    setVerificationState(staffToEdit?.emailChangeStatus === "pending" ? "pending" : "idle");
  }, [open, staffToEdit]);

  React.useEffect(() => {
    if (!open || verificationState !== "pending" || staffToEdit?.emailChangeStatus !== "completed") return;
    setVerificationState("completed");
    setEmail(staffToEdit.email);
    setErrorMessage("");
  }, [open, staffToEdit?.email, staffToEdit?.emailChangeStatus, verificationState]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const staffData: StaffFormData = {
      role,
      username: username.trim(),
      email: email.trim().toLowerCase(),
    };
    if (!staffData.username || !staffData.email) {
      setErrorMessage("Username and email are required.");
      return;
    }

    const emailChanged = staffToEdit ? staffData.email !== staffToEdit.email.toLowerCase() : true;
    const validationMessage = emailChanged ? validateNewEmail(staffData.email) : null;
    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");
      const result = await onSave(staffData);
      if (result === "verification-pending") setVerificationState("pending");
      else onOpenChange(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to save this staff account.");
    } finally {
      setIsSaving(false);
    }
  };

  const cancelVerificationAndClose = async () => {
    if (isSaving || isCancellingVerification) return;
    if (verificationState !== "pending") {
      onOpenChange(false);
      return;
    }

    try {
      setIsCancellingVerification(true);
      setErrorMessage("");
      await onCancelVerification();
      setVerificationState("idle");
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to cancel this email verification.");
    } finally {
      setIsCancellingVerification(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    if (isSaving || isCancellingVerification) return;
    if (verificationState === "pending") {
      void cancelVerificationAndClose();
      return;
    }
    onOpenChange(false);
  };

  const controlsDisabled = isSaving || isCancellingVerification || verificationState !== "idle";
  let submitLabel = staffToEdit ? "Save changes" : "Send verification email";
  if (isSaving) submitLabel = "Saving changes...";
  if (verificationState === "pending") submitLabel = "Waiting for verification";
  let cancelLabel = verificationState === "pending" ? "Cancel verification" : "Cancel";
  if (isCancellingVerification) cancelLabel = "Cancelling...";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isSaving && !isCancellingVerification}>
        <form
          onSubmit={handleSubmit}
          aria-busy={isSaving || isCancellingVerification || verificationState === "pending"}
        >
          <DialogHeader>
            <DialogTitle>{staffToEdit ? "Edit staff member" : "Add staff member"}</DialogTitle>
            <DialogDescription>
              {staffToEdit
                ? "Update the profile. A changed email remains pending until the new address verifies the link."
                : "The staff record is added only after the recipient verifies the email and sets a password."}
            </DialogDescription>
          </DialogHeader>

          {errorMessage && (
            <Alert variant="destructive" className="mt-4">
              <AlertTitle>Unable to continue</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}
          {!staffToEdit && (
            <Alert className="mt-4">
              <MailCheck />
              <AlertTitle>Email verification required</AlertTitle>
              <AlertDescription>
                The verification link expires after 24 hours and can only be used once.
              </AlertDescription>
            </Alert>
          )}
          {verificationState === "pending" && (
            <Alert className="mt-4">
              <Spinner />
              <AlertTitle>
                {isCancellingVerification ? "Cancelling email verification" : "Waiting for email verification"}
              </AlertTitle>
              <AlertDescription>
                {isCancellingVerification
                  ? "Removing the pending address. The original login email will remain active."
                  : `Firebase is waiting for ${staffToEdit?.pendingEmail ?? email} to verify the email link. Close this dialog to cancel the request and keep the original email.`}
              </AlertDescription>
            </Alert>
          )}
          {verificationState === "completed" && (
            <Alert className="mt-4">
              <CheckCircle2 />
              <AlertTitle>Email updated successfully</AlertTitle>
              <AlertDescription>
                The verified login email is now {staffToEdit?.email ?? email}. Firebase and Firestore are synchronized.
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="staff-role">System role</FieldLabel>
              <Select value={role} onValueChange={(value) => setRole(value as StaffRole)} disabled={controlsDisabled}>
                <SelectTrigger id="staff-role" className="w-full">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="Administrator">Administrator</SelectItem>
                    <SelectItem value="Operator">Operator</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="staff-username">Username</FieldLabel>
              <Input
                id="staff-username"
                placeholder="e.g. john.doe"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={controlsDisabled}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="staff-email">Email address</FieldLabel>
              <Input
                id="staff-email"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                disabled={controlsDisabled}
                required
              />
              <FieldDescription>
                {staffToEdit
                  ? "The current login email stays active until the new address is verified."
                  : "SmartRoad sends a secure verification link to this address."}
              </FieldDescription>
            </Field>

            {staffToEdit && (
              <Field data-disabled>
                <FieldLabel htmlFor="staff-date-joined">Date joined</FieldLabel>
                <Input id="staff-date-joined" type="text" value={staffToEdit.dateJoined} disabled />
              </Field>
            )}
          </FieldGroup>

          <DialogFooter>
            {verificationState === "completed" ? (
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void cancelVerificationAndClose()}
                  disabled={isSaving || isCancellingVerification}
                >
                  {isCancellingVerification && <Spinner data-icon="inline-start" />}
                  {cancelLabel}
                </Button>
                <Button type="submit" disabled={controlsDisabled}>
                  {(isSaving || verificationState === "pending") && <Spinner data-icon="inline-start" />}
                  {submitLabel}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
