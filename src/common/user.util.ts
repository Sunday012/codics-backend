import { User, Role, UserStatus } from '@prisma/client';

export interface SafeUser {
  id: string;
  name: string;
  fullName: string;
  email: string | null;
  matricNo: string | null;
  staffId: string | null;
  role: Role;
  departmentId: string | null;
  department?: string | null;
  level: number | string | null;
  status: UserStatus;
  repTermEnd?: string | null;
  repTermEndDate?: string | null;
}

export function toSafeUser(
  user: User & { department?: { name: string } | null },
): SafeUser {
  return {
    id: user.id,
    name: user.fullName,
    fullName: user.fullName,
    email: user.email,
    matricNo: user.matricNo,
    staffId: user.staffId,
    role: user.role,
    departmentId: user.departmentId,
    department: user.department?.name || null,
    level: user.level,
    status: user.status,
    repTermEnd: user.repTermEnd ? user.repTermEnd.toISOString() : null,
    repTermEndDate: user.repTermEnd ? user.repTermEnd.toISOString() : null,
  };
}
