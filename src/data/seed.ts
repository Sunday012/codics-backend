import { hashSync } from 'bcryptjs';
import { Database } from './entities';

const passwordHash = hashSync('password123', 10);
const now = new Date().toISOString();

export function createSeed(): Database {
  return {
    users: [
      { id: 'usr-student-01', name: 'Amina Bello', email: 'amina.bello@foc.edu.ng', passwordHash, role: 'student', department: 'Computer Science', level: '300', matricNo: 'CSC/2022/084', avatar: '', status: 'active' },
      { id: 'usr-rep-01', name: 'Chidi Okonkwo', email: 'chidi.okonkwo@foc.edu.ng', passwordHash, role: 'course_rep', department: 'Software Engineering', level: '300', matricNo: 'SEN/2022/012', avatar: '', status: 'active', repTermEndDate: '2028-12-31' },
      { id: 'usr-lecturer-01', name: 'Dr. Ibrahim Adeleke', email: 'i.adeleke@foc.edu.ng', passwordHash, role: 'lecturer', department: 'Computer Science', level: 'PG', staffId: 'FOC/L/014', avatar: '', status: 'active' },
      { id: 'usr-hod-01', name: 'Dr. Grace Okafor', email: 'hod.cs@foc.edu.ng', passwordHash, role: 'hod', department: 'Computer Science', level: 'PG', staffId: 'FOC/H/002', avatar: '', status: 'active' },
      { id: 'usr-admin-01', name: 'Prof. Florence Nnamdi', email: 'dean.computing@foc.edu.ng', passwordHash, role: 'admin', department: 'Faculty Office', level: 'PG', staffId: 'FOC/A/001', avatar: '', status: 'active' },
    ],
    departments: [
      { id: 'dept-csc', name: 'Computer Science', code: 'CSC', isActive: true },
      { id: 'dept-sen', name: 'Software Engineering', code: 'SEN', isActive: true },
      { id: 'dept-cyb', name: 'Cyber Security', code: 'CYB', isActive: true },
      { id: 'dept-it', name: 'Information Technology', code: 'IFT', isActive: true },
    ],
    courses: [
      { id: 'course-csc301', code: 'CSC 301', title: 'Data Structures and Algorithms', unit: 3, department: 'Computer Science', level: '300', description: 'Core data structures, algorithms and complexity analysis.' },
      { id: 'course-sen301', code: 'SEN 301', title: 'Software Engineering', unit: 3, department: 'Software Engineering', level: '300', description: 'Software process, requirements, design and quality.' },
    ],
    offerings: [
      { id: 'off-csc301-2026', courseId: 'course-csc301', courseCode: 'CSC 301', session: '2026/2027', semester: 'First Semester', lecturerIds: ['usr-lecturer-01'], lecturerNames: ['Dr. Ibrahim Adeleke'] },
    ],
    enrollments: [
      { id: 'enr-001', userId: 'usr-student-01', offeringId: 'off-csc301-2026', courseId: 'course-csc301', courseCode: 'CSC 301', type: 'regular', session: '2026/2027' },
    ],
    modules: [
      { id: 'mod-csc301-1', offeringId: 'off-csc301-2026', title: 'Introduction to Algorithms', order: 1, weekNumber: 1, description: 'Complexity and asymptotic analysis' },
    ],
    materials: [
      { id: 'mat-csc301-1', moduleId: 'mod-csc301-1', offeringId: 'off-csc301-2026', title: 'Big-O notation notes', type: 'note', contentOrUrl: 'Growth rates, upper bounds and common complexity classes.', status: 'published', createdAt: now },
    ],
    notices: [
      { id: 'notice-welcome', title: 'Welcome to CODICS', content: 'Course resources and faculty updates are now available.', category: 'general', scope: 'faculty', authorId: 'usr-admin-01', authorName: 'Prof. Florence Nnamdi', authorRole: 'admin', isUrgent: false, createdAt: now, readBy: [] },
    ],
    assignments: [
      { id: 'asg-csc301-1', courseId: 'course-csc301', offeringId: 'off-csc301-2026', courseCode: 'CSC 301', department: 'Computer Science', level: '300', title: 'Algorithm Analysis', instructions: 'Analyse the supplied algorithms and submit a PDF.', dueDate: '2027-01-31T23:59:00.000Z', totalMarks: 20, createdAt: now, status: 'published', allowedFileTypes: ['.pdf'], maxSizeBytes: 10485760, allowLate: false, lecturerIds: ['usr-lecturer-01'], studentDeadlineExtensions: {} },
    ],
    submissions: [],
    pastQuestions: [],
    roleAssignments: [
      { id: 'role-admin-01', userId: 'usr-admin-01', userName: 'Prof. Florence Nnamdi', role: 'admin', scopeType: 'faculty', scopeId: 'faculty', scopeName: 'Faculty of Computing', validFrom: '2025-01-01', validTo: '2030-12-31', isActive: true, createdAt: now },
    ],
    auditLogs: [],
    settings: { session: '2026/2027', semester: 'First Semester' },
  };
}
