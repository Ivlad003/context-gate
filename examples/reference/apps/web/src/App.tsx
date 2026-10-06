import { Button } from './Button.tsx'
import { UserList } from './UserList.tsx'

export function App() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <UserList />
      <Button onClick={() => location.reload()}>Refresh</Button>
    </main>
  )
}
