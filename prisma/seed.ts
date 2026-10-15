import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to seed the database');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const ids = {
  student: '00000000-0000-4000-8000-000000000001',
  rep: '00000000-0000-4000-8000-000000000002',
  lecturer: '00000000-0000-4000-8000-000000000003',
  hod: '00000000-0000-4000-8000-000000000004',
  admin: '00000000-0000-4000-8000-000000000005',
  course: '00000000-0000-4000-8000-000000000101',
  senCourse: '00000000-0000-4000-8000-000000000102',
  offering: '00000000-0000-4000-8000-000000000201',
  enrollment: '00000000-0000-4000-8000-000000000301',
  module: '00000000-0000-4000-8000-000000000401',
  material: '00000000-0000-4000-8000-000000000501',
  notice: '00000000-0000-4000-8000-000000000601',
  assignment: '00000000-0000-4000-8000-000000000701',
  adminRole: '00000000-0000-4000-8000-000000000801',
};

async function main() {
  const passwordHash = await hash('password123', 12);
  const users = [
    { id: ids.student, name: 'Amina Bello', email: 'amina.bello@foc.edu.ng', role: 'student', department: 'Computer Science', level: '300', matricNo: 'CSC/2022/084', status: 'active' },
    { id: ids.rep, name: 'Chidi Okonkwo', email: 'chidi.okonkwo@foc.edu.ng', role: 'course_rep', department: 'Software Engineering', level: '300', matricNo: 'SEN/2022/012', status: 'active', repTermEndDate: new Date('2028-12-31') },
    { id: ids.lecturer, name: 'Dr. Ibrahim Adeleke', email: 'i.adeleke@foc.edu.ng', role: 'lecturer', department: 'Computer Science', level: 'PG', staffId: 'FOC/L/014', status: 'active' },
    { id: ids.hod, name: 'Dr. Grace Okafor', email: 'hod.cs@foc.edu.ng', role: 'hod', department: 'Computer Science', level: 'PG', staffId: 'FOC/H/002', status: 'active' },
    { id: ids.admin, name: 'Prof. Florence Nnamdi', email: 'dean.computing@foc.edu.ng', role: 'admin', department: 'Faculty Office', level: 'PG', staffId: 'FOC/A/001', status: 'active' },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: { ...user, passwordHash },
      create: { ...user, passwordHash },
    });
  }

  for (const department of [
    { id: '00000000-0000-4000-8000-000000000901', name: 'Computer Science', code: 'CSC' },
    { id: '00000000-0000-4000-8000-000000000902', name: 'Software Engineering', code: 'SEN' },
    { id: '00000000-0000-4000-8000-000000000903', name: 'Cyber Security', code: 'CYB' },
    { id: '00000000-0000-4000-8000-000000000904', name: 'Information Technology', code: 'IFT' },
  ]) await prisma.department.upsert({ where: { code: department.code }, update: department, create: department });

  await prisma.course.upsert({ where: { code: 'CSC 301' }, update: {}, create: { id: ids.course, code: 'CSC 301', title: 'Data Structures and Algorithms', unit: 3, department: 'Computer Science', level: '300', description: 'Core data structures, algorithms and complexity analysis.' } });
  await prisma.course.upsert({ where: { code: 'SEN 301' }, update: {}, create: { id: ids.senCourse, code: 'SEN 301', title: 'Software Engineering', unit: 3, department: 'Software Engineering', level: '300', description: 'Software process, requirements, design and quality.' } });
  await prisma.offering.upsert({ where: { courseId_session_semester: { courseId: ids.course, session: '2026/2027', semester: 'First Semester' } }, update: {}, create: { id: ids.offering, courseId: ids.course, courseCode: 'CSC 301', session: '2026/2027', semester: 'First Semester', lecturerIds: [ids.lecturer], lecturerNames: ['Dr. Ibrahim Adeleke'] } });
  await prisma.enrollment.upsert({ where: { userId_offeringId: { userId: ids.student, offeringId: ids.offering } }, update: {}, create: { id: ids.enrollment, userId: ids.student, offeringId: ids.offering, courseId: ids.course, courseCode: 'CSC 301', type: 'regular', session: '2026/2027' } });
  await prisma.courseModule.upsert({ where: { offeringId_order: { offeringId: ids.offering, order: 1 } }, update: {}, create: { id: ids.module, offeringId: ids.offering, title: 'Introduction to Algorithms', order: 1, weekNumber: 1, description: 'Complexity and asymptotic analysis' } });
  await prisma.material.upsert({ where: { id: ids.material }, update: {}, create: { id: ids.material, moduleId: ids.module, offeringId: ids.offering, title: 'Big-O notation notes', type: 'note', contentOrUrl: 'Growth rates, upper bounds and common complexity classes.', status: 'published' } });
  await prisma.notice.upsert({ where: { id: ids.notice }, update: {}, create: { id: ids.notice, title: 'Welcome to CODICS', content: 'Course resources and faculty updates are now available.', category: 'general', scope: 'faculty', authorId: ids.admin, authorName: 'Prof. Florence Nnamdi', authorRole: 'admin' } });
  await prisma.assignment.upsert({ where: { id: ids.assignment }, update: {}, create: { id: ids.assignment, courseId: ids.course, offeringId: ids.offering, courseCode: 'CSC 301', department: 'Computer Science', level: '300', title: 'Algorithm Analysis', instructions: 'Analyse the supplied algorithms and submit a PDF.', dueDate: new Date('2099-01-31T23:59:00.000Z'), totalMarks: 20, status: 'published', allowedFileTypes: ['.pdf'], maxSizeBytes: 10485760, lecturerIds: [ids.lecturer] } });
  await prisma.roleAssignment.upsert({ where: { id: ids.adminRole }, update: {}, create: { id: ids.adminRole, userId: ids.admin, userName: 'Prof. Florence Nnamdi', role: 'admin', scopeType: 'faculty', scopeId: 'faculty', scopeName: 'Faculty of Computing', validFrom: new Date('2025-01-01'), validTo: new Date('2030-12-31') } });
  await prisma.academicSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default', session: '2026/2027', semester: 'First Semester' } });
}

main()
  .then(() => console.log('CODICS database seeded'))
  .finally(() => prisma.$disconnect());
