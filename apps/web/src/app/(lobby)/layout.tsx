import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LobbyShell } from '@/components/lobby/LobbyShell';
import './lobby.css';

export const metadata: Metadata = { title: 'Lobby' };

export default function LobbyLayout({ children }: { children: ReactNode }) {
  return <LobbyShell>{children}</LobbyShell>;
}
