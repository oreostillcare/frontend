"use client";

import * as React from "react";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { ArrowUpDown, Eye, EyeOff, Plus, SquarePen, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFirebaseAccount } from "@/hooks/use-firebase-account";
import { db } from "@/lib/firebase/client";
import {
  addStaffMember,
  deleteStaffMember,
  fetchStaffMembers,
  INITIAL_STAFF_MEMBERS,
  updateStaffMember,
} from "@/lib/firebase/staff-service";

import { DeleteStaffDialog } from "./delete-staff-dialog";
import { StaffDialog } from "./staff-dialog";
import type { StaffFormData, StaffMember, StaffRole } from "./staff-types";

type SortField = "role" | "username" | "email" | "password" | "dateJoined";

export function StaffTable() {
  const { user } = useFirebaseAccount();
  const [currentUserRole, setCurrentUserRole] = React.useState<StaffRole>("Administrator");
  const [staffList, setStaffList] = React.useState<StaffMember[]>(INITIAL_STAFF_MEMBERS);
  const [isLoading, setIsLoading] = React.useState(true);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [sortField, setSortField] = React.useState<SortField>("dateJoined");
  const [sortDirection, setSortDirection] = React.useState<"asc" | "desc">("desc");
  const [visiblePasswords, setVisiblePasswords] = React.useState<Record<string, boolean>>({});

  // Pagination state
  const [currentPage, setCurrentPage] = React.useState(1);
  const pageSize = 5;

  // Dialog states
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingStaff, setEditingStaff] = React.useState<StaffMember | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [staffToDelete, setStaffToDelete] = React.useState<StaffMember | null>(null);

  // Check current user's role from Firestore
  React.useEffect(() => {
    async function checkUserRole() {
      if (!user?.email || !db) return;
      try {
        const staffRef = collection(db, "staff");
        const q = query(staffRef, where("email", "==", user.email), limit(1));
        const snap = await getDocs(q);
        if (!snap.empty) {
          const data = snap.docs[0].data();
          if (data.role) {
            setCurrentUserRole(data.role as StaffRole);
          }
        }
      } catch (err) {
        console.warn("Could not determine current user role from Firestore:", err);
      }
    }
    checkUserRole();
  }, [user?.email]);

  const isAdmin = currentUserRole === "Administrator";

  const loadStaff = React.useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await fetchStaffMembers();
      setStaffList(data);
    } catch (error) {
      console.error("Error fetching staff:", error);
      toast.error("Failed to load staff list from Firestore.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
    setCurrentPage(1);
  };

  const togglePasswordVisibility = (id: string) => {
    setVisiblePasswords((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const maskPassword = (password?: string) => {
    if (!password) return "••••••••";
    if (password.length <= 2) return "••";
    const firstChar = password.charAt(0);
    return `${firstChar}**${"•".repeat(Math.max(3, password.length - 3))}`;
  };

  // Filtered and sorted data
  const filteredStaff = React.useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const list = staffList.filter(
      (item) =>
        item.role.toLowerCase().includes(query) ||
        item.username.toLowerCase().includes(query) ||
        item.email.toLowerCase().includes(query),
    );

    list.sort((a, b) => {
      let aVal = a[sortField] || "";
      let bVal = b[sortField] || "";

      if (sortField === "username") {
        aVal = a.username;
        bVal = b.username;
      }

      const comparison = String(aVal).localeCompare(String(bVal));
      return sortDirection === "asc" ? comparison : -comparison;
    });

    return list;
  }, [staffList, searchQuery, sortField, sortDirection]);

  // Paginated data
  const totalPages = Math.max(1, Math.ceil(filteredStaff.length / pageSize));
  const paginatedStaff = React.useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredStaff.slice(start, start + pageSize);
  }, [filteredStaff, currentPage, pageSize]);

  // Add / Edit handler
  const handleSaveStaff = async (formData: StaffFormData) => {
    if (!isAdmin) return;
    if (editingStaff) {
      // Update
      await updateStaffMember(editingStaff.id, formData);
      setStaffList((prev) => prev.map((item) => (item.id === editingStaff.id ? { ...item, ...formData } : item)));
      toast.success(`Updated account for ${formData.username}`);
    } else {
      // Create
      const newStaff = await addStaffMember(formData);
      setStaffList((prev) => [newStaff, ...prev]);
      toast.success(`Staff member ${formData.username} added successfully`);
    }
  };

  // Delete handler
  const handleDeleteConfirm = async () => {
    if (!isAdmin || !staffToDelete) return;
    await deleteStaffMember(staffToDelete.id);
    setStaffList((prev) => prev.filter((item) => item.id !== staffToDelete.id));
    toast.success(`Removed account for ${staffToDelete.username}`);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">Staff Information</h1>
        <p className="text-sm text-muted-foreground">
          Manage system administrator and operator staff accounts connected to Firebase Firestore.
        </p>
      </div>

      <Card className="rounded-xl border shadow-xs">
        <CardContent className="p-4 md:p-6">
          {/* Top Controls Row */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {isAdmin && (
                <Button
                  onClick={() => {
                    setEditingStaff(null);
                    setDialogOpen(true);
                  }}
                  className="h-9 gap-1.5 font-medium"
                >
                  <Plus className="size-4" />
                  Add Staff
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="staff-search-input" className="text-sm font-medium text-foreground">
                Search:
              </label>
              <Input
                id="staff-search-input"
                placeholder="Search staff..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="h-8 w-44 md:w-56"
              />
            </div>
          </div>

          {/* Table Container */}
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead
                    onClick={() => handleSort("role")}
                    className="cursor-pointer select-none font-semibold text-foreground"
                  >
                    <div className="flex items-center gap-1.5">
                      Role
                      <ArrowUpDown className="size-3.5 text-muted-foreground" />
                    </div>
                  </TableHead>

                  <TableHead
                    onClick={() => handleSort("username")}
                    className="cursor-pointer select-none font-semibold text-foreground"
                  >
                    <div className="flex items-center gap-1.5">
                      Username
                      <ArrowUpDown className="size-3.5 text-muted-foreground" />
                    </div>
                  </TableHead>

                  <TableHead
                    onClick={() => handleSort("email")}
                    className="cursor-pointer select-none font-semibold text-foreground"
                  >
                    <div className="flex items-center gap-1.5">
                      Email
                      <ArrowUpDown className="size-3.5 text-muted-foreground" />
                    </div>
                  </TableHead>

                  <TableHead
                    onClick={() => handleSort("password")}
                    className="cursor-pointer select-none font-semibold text-foreground"
                  >
                    <div className="flex items-center gap-1.5">
                      Password
                      <ArrowUpDown className="size-3.5 text-muted-foreground" />
                    </div>
                  </TableHead>

                  <TableHead
                    onClick={() => handleSort("dateJoined")}
                    className="cursor-pointer select-none font-semibold text-foreground"
                  >
                    <div className="flex items-center gap-1.5">
                      Date Joined
                      <ArrowUpDown className="size-3.5 text-muted-foreground" />
                    </div>
                  </TableHead>

                  {isAdmin && (
                    <TableHead className="text-right font-semibold text-foreground">
                      <div className="flex items-center justify-end gap-1.5">
                        Actions
                        <ArrowUpDown className="size-3.5 text-muted-foreground" />
                      </div>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>

              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={isAdmin ? 6 : 5} className="h-32 text-center text-sm text-muted-foreground">
                      Loading staff records...
                    </TableCell>
                  </TableRow>
                ) : paginatedStaff.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isAdmin ? 6 : 5} className="h-32 text-center text-sm text-muted-foreground">
                      No staff records found matching your search.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedStaff.map((staff) => {
                    const isVisible = visiblePasswords[staff.id];
                    return (
                      <TableRow key={staff.id} className="hover:bg-muted/40">
                        <TableCell>
                          <Badge
                            variant={staff.role === "Administrator" ? "default" : "outline"}
                            className="font-medium"
                          >
                            {staff.role}
                          </Badge>
                        </TableCell>

                        <TableCell className="font-medium text-foreground">{staff.username}</TableCell>

                        <TableCell className="max-w-[180px] truncate text-muted-foreground">{staff.email}</TableCell>

                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm tracking-wider text-muted-foreground">
                              {isVisible ? staff.password || "••••••••" : maskPassword(staff.password)}
                            </span>
                            <button
                              type="button"
                              onClick={() => togglePasswordVisibility(staff.id)}
                              className="text-muted-foreground transition-colors hover:text-foreground"
                              title={isVisible ? "Hide password" : "Show password"}
                            >
                              {isVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                            </button>
                          </div>
                        </TableCell>

                        <TableCell className="text-muted-foreground whitespace-nowrap">{staff.dateJoined}</TableCell>

                        {isAdmin && (
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => {
                                  setEditingStaff(staff);
                                  setDialogOpen(true);
                                }}
                                className="size-8 text-muted-foreground hover:text-foreground"
                                title="Edit staff member"
                              >
                                <SquarePen className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => {
                                  setStaffToDelete(staff);
                                  setDeleteDialogOpen(true);
                                }}
                                className="size-8 text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
                                title="Delete staff member"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination Controls */}
          <div className="mt-4 flex items-center justify-end gap-1 text-sm text-muted-foreground">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              className="h-8 px-3 text-xs"
            >
              Previous
            </Button>

            {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
              <Button
                key={page}
                variant={currentPage === page ? "default" : "outline"}
                size="sm"
                onClick={() => setCurrentPage(page)}
                className="h-8 min-w-8 px-2 text-xs"
              >
                {page}
              </Button>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              className="h-8 px-3 text-xs"
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Dialogs - only accessible by Admin */}
      {isAdmin && (
        <>
          <StaffDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            staffToEdit={editingStaff}
            onSave={handleSaveStaff}
          />

          <DeleteStaffDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            staff={staffToDelete}
            onConfirmDelete={handleDeleteConfirm}
          />
        </>
      )}
    </div>
  );
}
