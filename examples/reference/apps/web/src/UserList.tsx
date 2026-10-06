import { useEffect, useState } from 'react'

interface User { id: string; email: string }

export function UserList() {
  const [users, setUsers] = useState<User[]>([])
  useEffect(() => {
    fetch('/api/users').then((r) => r.json()).then((b: { items: User[] }) => setUsers(b.items))
  }, [])
  return (
    <ul className="divide-y">
      {users.map((u) => <li key={u.id} className="py-2">{u.email}</li>)}
    </ul>
  )
}
