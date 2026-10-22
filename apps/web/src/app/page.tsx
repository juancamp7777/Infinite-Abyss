import { redirect } from "next/navigation";

/** La home es el lobby (Hub + Studios). Los juegos clásicos viven en /classic. */
export default function Home() {
  redirect("/lobby");
}
