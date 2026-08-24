"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StaffFormData, StaffMember, StaffRole } from "./staff-types";

interface StaffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staffToEdit?: StaffMember | null;
  onSave: (data: StaffFormData) => Promise<void> | void;
}

export function StaffDialog({ open, onOpenChange, staffToEdit, onSave }: StaffDialogProps) {
  const [role, setRole] = React.useState<StaffRole>("Administrator");
  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [dateJoined, setDateJoined] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState("");

  React.useEffect(() => {
    if (open) {
      if (staffToEdit) {
        setRole(staffToEdit.role || "Administrator");
        setUsername(staffToEdit.username || "");
        setEmail(staffToEdit.email || "");
        setPassword(staffToEdit.password || "");
        setDateJoined(staffToEdit.dateJoined || new Date().toISOString().split("T")[0]);
      } else {
        setRole("Administrator");
        setUsername("");
        setEmail("");
        setPassword("");
        setDateJoined(new Date().toISOString().split("T")[0]);
      }
      setShowPassword(false);
      setErrorMessage("");
    }
  }, [open, staffToEdit]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !email.trim()) {
      setErrorMessage("User (username) and Email are required.");
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage("");
      await onSave({
        role,
        username: username.trim(),
        email: email.trim(),
        password: password.trim() || "••••••••",
        dateJoined: dateJoined || new Date().toISOString().split("T")[0],
      });
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      setErrorMessage("Failed to save staff record. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{staffToEdit ? "Edit Staff Member" : "Add New Staff"}</DialogTitle>
            <DialogDescription>
              {staffToEdit
                ? "Update staff credentials and assigned system permissions."
                : "Enter the details for the new staff member account."}
            </DialogDescription>
          </DialogHeader>

          {errorMessage && (
            <div className="mt-3 rounded-md bg-destructive/15 p-2.5 text-xs text-destructive">{errorMessage}</div>
          )}

          <div className="grid gap-3.5 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="staff-role" className="text-xs font-medium">
                System Role
              </Label>
              <Select value={role} onValueChange={(val) => setRole(val as StaffRole)}>
                <SelectTrigger id="staff-role" className="w-full">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Administrator">Administrator (Full CRUD & Settings)</SelectItem>
                  <SelectItem value="Operator">Operator (Live View & Monitoring)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="staff-username" className="text-xs font-medium">
                Username
              </Label>
              <Input
                id="staff-username"
                placeholder="e.g. john.doe"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="staff-email" className="text-xs font-medium">
                Email Address
              </Label>
              <Input
                id="staff-email"
                type="email"
                placeholder="e.g. john.d@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="staff-password" className="text-xs font-medium">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="staff-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter account password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="staff-date-joined" className="text-xs font-medium">
                Date Joined
              </Label>
              <Input
                id="staff-date-joined"
                type="date"
                value={dateJoined}
                onChange={(e) => setDateJoined(e.target.value)}
                required
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : staffToEdit ? "Save Changes" : "Add Staff"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
