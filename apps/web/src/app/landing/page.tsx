import { redirect } from "next/navigation";

/** La landing comercial ahora vive en /plataforma; la raíz del dominio es el casino. */
export default function LandingPage() {
  redirect("/plataforma");
}
