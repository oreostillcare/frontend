export type StaffRole = "Administrator" | "Operator";

export interface StaffMember {
  id: string;
  role: StaffRole;
  username: string;
  email: string;
  password?: string;
  dateJoined: string;
}

export type StaffFormData = Omit<StaffMember, "id">;
