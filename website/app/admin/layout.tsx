import type { Metadata } from "next";
import { currentEnvironment } from "@/lib/environment";
import AdminShell from "./admin-shell";

export const metadata: Metadata = {
  title: "Owner dashboard",
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell environment={currentEnvironment()}>{children}</AdminShell>;
}
