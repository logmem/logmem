// The bare domain opens the space picker. Signed-out visitors go on to /sign-in from there.
import { redirect } from 'next/navigation';

export default function RootPage() {
  redirect('/select-space');
}
