"use client";

import { useRouter } from "next/navigation";

import { zodResolver } from "@hookform/resolvers/zod";
import { FirebaseError } from "firebase/app";
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  setPersistence,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { auth, db } from "@/lib/firebase/client";

const formSchema = z.object({
  identifier: z.string().min(1, { message: "Please enter your username or email address." }),
  password: z.string().min(1, { message: "Please enter your password." }),
  remember: z.boolean().optional(),
});

interface StaffAccount {
  email: string;
  password?: string;
  username: string;
  role?: string;
}

async function findStaffAccount(identifier: string): Promise<StaffAccount | null> {
  if (!db) return null;
  const trimmed = identifier.trim();
  const lower = trimmed.toLowerCase();

  try {
    const staffRef = collection(db, "staff");

    // 1. Try querying by username
    let snap = await getDocs(query(staffRef, where("username", "==", trimmed), limit(1)));
    if (snap.empty && lower !== trimmed) {
      snap = await getDocs(query(staffRef, where("username", "==", lower), limit(1)));
    }
    if (!snap.empty) {
      return snap.docs[0].data() as StaffAccount;
    }

    // 2. Try querying by email
    let snapEmail = await getDocs(query(staffRef, where("email", "==", trimmed), limit(1)));
    if (snapEmail.empty && lower !== trimmed) {
      snapEmail = await getDocs(query(staffRef, where("email", "==", lower), limit(1)));
    }
    if (!snapEmail.empty) {
      return snapEmail.docs[0].data() as StaffAccount;
    }
  } catch (e) {
    console.warn("Error finding staff account in Firestore:", e);
  }

  return null;
}

export function LoginForm() {
  const router = useRouter();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      identifier: "",
      password: "",
      remember: false,
    },
  });

  async function onSubmit(data: z.infer<typeof formSchema>) {
    if (!auth) {
      form.setError("root", { message: "Firebase Authentication is not configured." });
      return;
    }

    try {
      await setPersistence(auth, data.remember ? browserLocalPersistence : browserSessionPersistence);

      const input = data.identifier.trim();
      const staffAccount = await findStaffAccount(input);

      const emailToAuth = staffAccount?.email || (input.includes("@") ? input : null);

      if (!emailToAuth) {
        form.setError("root", {
          message: `No account found for username "${input}". Please check your username or enter your email address.`,
        });
        return;
      }

      // Try signing in with Firebase Auth
      try {
        await signInWithEmailAndPassword(auth, emailToAuth, data.password);
        const nextPath = new URLSearchParams(window.location.search).get("next");
        router.replace(nextPath || "/dashboard");
        return;
      } catch (signInError) {
        // If staff record exists in Firestore with matching password, auto-create in Firebase Auth
        if (staffAccount && staffAccount.password === data.password) {
          try {
            await createUserWithEmailAndPassword(auth, staffAccount.email, data.password);
            const nextPath = new URLSearchParams(window.location.search).get("next");
            router.replace(nextPath || "/dashboard");
            return;
          } catch (createError) {
            console.warn("Auto Firebase Auth sync error:", createError);
          }
        }

        throw signInError;
      }
    } catch (error) {
      console.error("Login error:", error);
      form.setError("root", {
        message:
          error instanceof FirebaseError &&
          (error.code === "auth/invalid-credential" ||
            error.code === "auth/user-not-found" ||
            error.code === "auth/wrong-password" ||
            error.code === "auth/invalid-email")
            ? "Invalid username/email or password."
            : "Unable to sign in. Please verify your credentials and try again.",
      });
    }
  }

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="identifier"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-identifier">Username or Email</FieldLabel>
              <Input
                {...field}
                id="login-identifier"
                type="text"
                placeholder="Enter username or email address"
                autoComplete="username"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-password">Password</FieldLabel>
              <Input
                {...field}
                id="login-password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="remember"
          render={({ field, fieldState }) => (
            <Field orientation="horizontal" data-invalid={fieldState.invalid}>
              <Checkbox
                id="login-remember"
                name={field.name}
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(Boolean(checked))}
                aria-invalid={fieldState.invalid}
              />
              <FieldContent>
                <FieldLabel htmlFor="login-remember" className="font-normal">
                  Remember me for 30 days
                </FieldLabel>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FieldContent>
            </Field>
          )}
        />
      </FieldGroup>
      {form.formState.errors.root && (
        <p className="text-sm text-destructive" role="alert">
          {form.formState.errors.root.message}
        </p>
      )}
      <Button className="w-full" disabled={form.formState.isSubmitting} type="submit">
        {form.formState.isSubmitting && <Spinner data-icon="inline-start" />}
        Login
      </Button>
    </form>
  );
}
