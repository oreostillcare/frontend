import { addDoc, collection, deleteDoc, doc, getDocs, orderBy, query, updateDoc } from "firebase/firestore";

import type { StaffFormData, StaffMember } from "@/app/(main)/dashboard/staff/_components/staff-types";
import { db } from "./client";

export const INITIAL_STAFF_MEMBERS: StaffMember[] = [
  {
    id: "staff-1",
    role: "Administrator",
    username: "john.doe",
    email: "john.d@company.com",
    password: "Password123!",
    dateJoined: "2023-01-15",
  },
  {
    id: "staff-2",
    role: "Administrator",
    username: "jane.smith",
    email: "j.smith@company.com",
    password: "Password123!",
    dateJoined: "2022-11-20",
  },
  {
    id: "staff-3",
    role: "Operator",
    username: "bob.jones",
    email: "b.jones@company.com",
    password: "Password123!",
    dateJoined: "2024-03-01",
  },
  {
    id: "staff-4",
    role: "Administrator",
    username: "s.green",
    email: "s.green@company.com",
    password: "Password123!",
    dateJoined: "2021-09-10",
  },
];

const COLLECTION_NAME = "staff";

export async function fetchStaffMembers(): Promise<StaffMember[]> {
  if (!db) {
    return INITIAL_STAFF_MEMBERS;
  }

  try {
    const staffRef = collection(db, COLLECTION_NAME);
    const q = query(staffRef, orderBy("dateJoined", "desc"));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return INITIAL_STAFF_MEMBERS;
    }

    return snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        role: data.role || "Operator",
        username: data.username || "",
        email: data.email || "",
        password: data.password || "",
        dateJoined: data.dateJoined || new Date().toISOString().split("T")[0],
      } as StaffMember;
    });
  } catch (error) {
    console.warn("Firestore fetch error, falling back to local dataset:", error);
    return INITIAL_STAFF_MEMBERS;
  }
}

export async function addStaffMember(staffData: StaffFormData): Promise<StaffMember> {
  if (!db) {
    return {
      id: `staff-${Date.now()}`,
      ...staffData,
    };
  }

  try {
    const staffRef = collection(db, COLLECTION_NAME);
    const docRef = await addDoc(staffRef, {
      ...staffData,
      createdAt: new Date().toISOString(),
    });

    return {
      id: docRef.id,
      ...staffData,
    };
  } catch (error) {
    console.error("Error adding staff to Firestore:", error);
    return {
      id: `staff-${Date.now()}`,
      ...staffData,
    };
  }
}

export async function updateStaffMember(id: string, staffData: Partial<StaffFormData>): Promise<void> {
  if (!db) return;

  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    await updateDoc(docRef, {
      ...staffData,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error updating staff in Firestore:", error);
  }
}

export async function deleteStaffMember(id: string): Promise<void> {
  if (!db) return;

  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    await deleteDoc(docRef);
  } catch (error) {
    console.error("Error deleting staff from Firestore:", error);
  }
}
