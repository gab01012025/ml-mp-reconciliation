import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ML-MP Conciliação Financeira',
  description: 'Sistema de conciliação financeira Mercado Livre e Mercado Pago',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-gray-50">
        {children}
      </body>
    </html>
  );
}
