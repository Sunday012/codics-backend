export type Role = 'admin' | 'hod' | 'lecturer' | 'course_rep' | 'student';
export type Level = '100' | '200' | '300' | '400' | '500' | 'PG';

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  department: string;
  level: Level;
  matricNo?: string;
  staffId?: string;
  avatar: string;
  status: 'invited' | 'active' | 'suspended';
  repTermEndDate?: string;
  refreshTokenHash?: string;
}

export interface Notice {
  id: string;
  title: string;
  content: string;
  category: 'academic' | 'exam' | 'event' | 'urgent' | 'general';
  scope: 'faculty' | 'department' | 'level' | 'course';
  authorId: string;
  authorName: string;
  authorRole: Role;
  isUrgent: boolean;
  createdAt: string;
  updatedAt?: string;
  targetLevel?: string;
  targetDepartment?: string;
  courseCode?: string;
  readBy: string[];
  isHidden?: boolean;
  hiddenReason?: string;
}

export interface Course {
  id: string;
  code: string;
  title: string;
  unit: number;
  department: string;
  level: Level;
  description: string;
}

export interface Offering {
  id: string;
  courseId: string;
  courseCode: string;
  session: string;
  semester: 'First Semester' | 'Second Semester';
  lecturerIds: string[];
  lecturerNames: string[];
}

export interface Enrollment {
  id: string;
  userId: string;
  offeringId: string;
  courseId: string;
  courseCode: string;
  type: 'regular' | 'carryover' | 'elective';
  session: string;
}

export interface CourseModule {
  id: string;
  offeringId: string;
  title: string;
  order: number;
  weekNumber?: number;
  description?: string;
}

export interface Material {
  id: string;
  moduleId: string;
  offeringId: string;
  title: string;
  type: 'pdf' | 'slides' | 'note' | 'link';
  contentOrUrl: string;
  fileSizeBytes?: number;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt?: string;
}

export interface Assignment {
  id: string;
  courseId: string;
  offeringId: string;
  courseCode: string;
  department: string;
  level: string;
  title: string;
  instructions: string;
  dueDate: string;
  totalMarks: number;
  createdAt: string;
  status: 'draft' | 'published';
  allowedFileTypes: string[];
  maxSizeBytes: number;
  allowLate: boolean;
  lecturerIds: string[];
  studentDeadlineExtensions: Record<string, string>;
}

export interface SubmissionVersion {
  version: number;
  fileUrl: string;
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  submittedAt: string;
  isLate: boolean;
}

export interface Submission {
  id: string;
  assignmentId: string;
  courseCode: string;
  studentId: string;
  studentName: string;
  studentMatric: string;
  version: number;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  submittedAt: string;
  isLate: boolean;
  versions: SubmissionVersion[];
  currentVersion: SubmissionVersion;
  score?: number;
  feedback?: string;
  status: 'submitted' | 'graded' | 'late';
}

export interface PastQuestion {
  id: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  department: string;
  level: Level;
  session: string;
  semester: 'First Semester' | 'Second Semester';
  examType: 'exam' | 'test' | 'quiz';
  fileUrl: string;
  fileName: string;
  uploaderId: string;
  uploaderName: string;
  status: 'pending' | 'approved' | 'rejected';
  uploadedAt: string;
  reviewedBy?: string;
  rejectionReason?: string;
  reports: Array<{ id: string; reportedBy: string; reason: string; note?: string; createdAt: string }>;
}

export interface RoleAssignment {
  id: string;
  userId: string;
  userName: string;
  role: 'course_rep' | 'hod' | 'admin';
  scopeType: 'department' | 'faculty' | 'course' | 'level';
  scopeId: string;
  scopeName: string;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: Role;
  action: string;
  targetType: string;
  targetId: string;
  targetName: string;
  reason?: string;
  createdAt: string;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
}

export interface Database {
  users: User[];
  notices: Notice[];
  courses: Course[];
  offerings: Offering[];
  enrollments: Enrollment[];
  modules: CourseModule[];
  materials: Material[];
  assignments: Assignment[];
  submissions: Submission[];
  pastQuestions: PastQuestion[];
  roleAssignments: RoleAssignment[];
  auditLogs: AuditEntry[];
  departments: Department[];
  settings: { session: string; semester: string };
}

export type SafeUser = Omit<User, 'passwordHash' | 'refreshTokenHash'>;

export function toSafeUser(user: User): SafeUser {
  const { passwordHash: _password, refreshTokenHash: _refresh, ...safe } = user;
  return safe;
}
