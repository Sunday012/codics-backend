import 'dotenv/config';
import { hash } from 'bcryptjs';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, UserStatus, Semester, EnrollmentType, MaterialType, MaterialStatus, AudienceScope, AssignmentStatus, RoleScopeType } from '@prisma/client';

if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: Refusing to run seed script in production environment.');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required to run seed.');
}

const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const demoPassword = process.env.DEMO_PASSWORD || 'password123';
  const passwordHash = await hash(demoPassword, 10);

  console.log('Seeding demo data into database...');

  // 1. Departments
  const deptCsc = await prisma.department.upsert({
    where: { code: 'CSC' },
    update: { name: 'Computer Science' },
    create: { id: 'dept-csc', code: 'CSC', name: 'Computer Science' },
  });

  const deptSen = await prisma.department.upsert({
    where: { code: 'SEN' },
    update: { name: 'Software Engineering' },
    create: { id: 'dept-sen', code: 'SEN', name: 'Software Engineering' },
  });

  const deptCyb = await prisma.department.upsert({
    where: { code: 'CYB' },
    update: { name: 'Cyber Security' },
    create: { id: 'dept-cyb', code: 'CYB', name: 'Cyber Security' },
  });

  const deptIft = await prisma.department.upsert({
    where: { code: 'IFT' },
    update: { name: 'Information Technology' },
    create: { id: 'dept-it', code: 'IFT', name: 'Information Technology' },
  });

  // 2. Settings
  const existingSetting = await prisma.setting.findFirst();
  if (existingSetting) {
    await prisma.setting.update({
      where: { id: existingSetting.id },
      data: { session: '2026/2027', semester: Semester.first },
    });
  } else {
    await prisma.setting.create({
      data: { session: '2026/2027', semester: Semester.first },
    });
  }

  // 3. Demo Users
  const student = await prisma.user.upsert({
    where: { matricNo: 'CSC/2022/084' },
    update: {
      passwordHash,
      status: UserStatus.active,
      fullName: 'Amina Bello',
      email: 'amina.bello@foc.edu.ng',
    },
    create: {
      id: 'usr-student-01',
      fullName: 'Amina Bello',
      email: 'amina.bello@foc.edu.ng',
      matricNo: 'CSC/2022/084',
      passwordHash,
      role: Role.student,
      departmentId: deptCsc.id,
      level: 300,
      status: UserStatus.active,
    },
  });

  await prisma.user.upsert({
    where: { matricNo: 'SEN/2022/012' },
    update: {
      passwordHash,
      status: UserStatus.active,
      fullName: 'Chidi Okonkwo',
      email: 'chidi.okonkwo@foc.edu.ng',
      repTermEnd: new Date('2028-12-31T23:59:59.000Z'),
    },
    create: {
      id: 'usr-rep-01',
      fullName: 'Chidi Okonkwo',
      email: 'chidi.okonkwo@foc.edu.ng',
      matricNo: 'SEN/2022/012',
      passwordHash,
      role: Role.course_rep,
      departmentId: deptSen.id,
      level: 300,
      status: UserStatus.active,
      repTermEnd: new Date('2028-12-31T23:59:59.000Z'),
    },
  });

  const lecturer = await prisma.user.upsert({
    where: { staffId: 'FOC/L/014' },
    update: {
      passwordHash,
      status: UserStatus.active,
      fullName: 'Dr. Ibrahim Adeleke',
      email: 'i.adeleke@foc.edu.ng',
    },
    create: {
      id: 'usr-lecturer-01',
      fullName: 'Dr. Ibrahim Adeleke',
      email: 'i.adeleke@foc.edu.ng',
      staffId: 'FOC/L/014',
      passwordHash,
      role: Role.lecturer,
      departmentId: deptCsc.id,
      status: UserStatus.active,
    },
  });

  await prisma.user.upsert({
    where: { staffId: 'FOC/H/002' },
    update: {
      passwordHash,
      status: UserStatus.active,
      fullName: 'Dr. Grace Okafor',
      email: 'hod.cs@foc.edu.ng',
    },
    create: {
      id: 'usr-hod-01',
      fullName: 'Dr. Grace Okafor',
      email: 'hod.cs@foc.edu.ng',
      staffId: 'FOC/H/002',
      passwordHash,
      role: Role.hod,
      departmentId: deptCsc.id,
      status: UserStatus.active,
    },
  });

  const admin = await prisma.user.upsert({
    where: { staffId: 'FOC/A/001' },
    update: {
      passwordHash,
      status: UserStatus.active,
      fullName: 'Prof. Florence Nnamdi',
      email: 'dean.computing@foc.edu.ng',
    },
    create: {
      id: 'usr-admin-01',
      fullName: 'Prof. Florence Nnamdi',
      email: 'dean.computing@foc.edu.ng',
      staffId: 'FOC/A/001',
      passwordHash,
      role: Role.admin,
      departmentId: deptCsc.id,
      status: UserStatus.active,
    },
  });

  // 3b. Invited Roster Students (for Account Activation flow)
  await prisma.user.upsert({
    where: { matricNo: 'CSC/2026/001' },
    update: {
      fullName: 'Blessing Okafor',
      email: 'b.okafor@stu.foc.edu.ng',
      departmentId: deptCsc.id,
      level: 100,
    },
    create: {
      id: 'usr-invited-01',
      fullName: 'Blessing Okafor',
      email: 'b.okafor@stu.foc.edu.ng',
      matricNo: 'CSC/2026/001',
      role: Role.student,
      departmentId: deptCsc.id,
      level: 100,
      status: UserStatus.invited,
    },
  });

  await prisma.user.upsert({
    where: { matricNo: 'SEN/2026/005' },
    update: {
      fullName: 'Tunde Bakare',
      email: 't.bakare@stu.foc.edu.ng',
      departmentId: deptSen.id,
      level: 100,
    },
    create: {
      id: 'usr-invited-02',
      fullName: 'Tunde Bakare',
      email: 't.bakare@stu.foc.edu.ng',
      matricNo: 'SEN/2026/005',
      role: Role.student,
      departmentId: deptSen.id,
      level: 100,
      status: UserStatus.invited,
    },
  });

  await prisma.user.upsert({
    where: { matricNo: 'CYB/2026/012' },
    update: {
      fullName: 'Fatima Mohammed',
      email: 'f.mohammed@stu.foc.edu.ng',
      departmentId: deptCyb.id,
      level: 200,
    },
    create: {
      id: 'usr-invited-03',
      fullName: 'Fatima Mohammed',
      email: 'f.mohammed@stu.foc.edu.ng',
      matricNo: 'CYB/2026/012',
      role: Role.student,
      departmentId: deptCyb.id,
      level: 200,
      status: UserStatus.invited,
    },
  });

  await prisma.user.upsert({
    where: { matricNo: 'IFT/2026/020' },
    update: {
      fullName: 'David Chen',
      email: 'd.chen@stu.foc.edu.ng',
      departmentId: deptIft.id,
      level: 100,
    },
    create: {
      id: 'usr-invited-04',
      fullName: 'David Chen',
      email: 'd.chen@stu.foc.edu.ng',
      matricNo: 'IFT/2026/020',
      role: Role.student,
      departmentId: deptIft.id,
      level: 100,
      status: UserStatus.invited,
    },
  });

  // 4. Courses
  const courseCsc301 = await prisma.course.upsert({
    where: { code: 'CSC 301' },
    update: { title: 'Data Structures and Algorithms', units: 3 },
    create: {
      id: 'course-csc301',
      code: 'CSC 301',
      title: 'Data Structures and Algorithms',
      units: 3,
      departmentId: deptCsc.id,
      level: 300,
      semester: Semester.first,
    },
  });

  await prisma.course.upsert({
    where: { code: 'SEN 301' },
    update: { title: 'Software Engineering', units: 3 },
    create: {
      id: 'course-sen301',
      code: 'SEN 301',
      title: 'Software Engineering',
      units: 3,
      departmentId: deptSen.id,
      level: 300,
      semester: Semester.first,
    },
  });

  // 5. Offering
  const offering = await prisma.offering.upsert({
    where: {
      courseId_session_semester: {
        courseId: courseCsc301.id,
        session: '2026/2027',
        semester: Semester.first,
      },
    },
    update: {},
    create: {
      id: 'off-csc301-2026',
      courseId: courseCsc301.id,
      session: '2026/2027',
      semester: Semester.first,
    },
  });

  // OfferingLecturer
  await prisma.offeringLecturer.upsert({
    where: {
      offeringId_userId: {
        offeringId: offering.id,
        userId: lecturer.id,
      },
    },
    update: {},
    create: {
      offeringId: offering.id,
      userId: lecturer.id,
    },
  });

  // Enrollment
  await prisma.enrollment.upsert({
    where: {
      offeringId_userId: {
        offeringId: offering.id,
        userId: student.id,
      },
    },
    update: { type: EnrollmentType.regular },
    create: {
      id: 'enr-001',
      offeringId: offering.id,
      userId: student.id,
      type: EnrollmentType.regular,
    },
  });

  // Module & Material
  const mod = await prisma.module.upsert({
    where: { id: 'mod-csc301-1' },
    update: { title: 'Introduction to Algorithms' },
    create: {
      id: 'mod-csc301-1',
      offeringId: offering.id,
      title: 'Introduction to Algorithms',
      order: 1,
      weekNumber: 1,
      description: 'Complexity and asymptotic analysis',
    },
  });

  await prisma.material.upsert({
    where: { id: 'mat-csc301-1' },
    update: { title: 'Big-O notation notes' },
    create: {
      id: 'mat-csc301-1',
      moduleId: mod.id,
      offeringId: offering.id,
      title: 'Big-O notation notes',
      type: MaterialType.note,
      body: 'Growth rates, upper bounds and common complexity classes.',
      status: MaterialStatus.published,
    },
  });

  // Notice
  await prisma.notice.upsert({
    where: { id: 'notice-welcome' },
    update: { title: 'Welcome to CODICS' },
    create: {
      id: 'notice-welcome',
      title: 'Welcome to CODICS',
      body: 'Course resources and faculty updates are now available.',
      scope: AudienceScope.faculty,
      authorId: admin.id,
      isUrgent: false,
    },
  });

  // Assignment
  await prisma.assignment.upsert({
    where: { id: 'asg-csc301-1' },
    update: { title: 'Algorithm Analysis' },
    create: {
      id: 'asg-csc301-1',
      offeringId: offering.id,
      title: 'Algorithm Analysis',
      instructions: 'Analyse the supplied algorithms and submit a PDF.',
      deadline: new Date('2027-01-31T23:59:00.000Z'),
      status: AssignmentStatus.published,
      allowedTypes: ['.pdf'],
      maxSizeBytes: 10485760,
      allowLate: false,
    },
  });

  // Role Assignment
  await prisma.roleAssignment.upsert({
    where: { id: 'role-admin-01' },
    update: { isActive: true },
    create: {
      id: 'role-admin-01',
      userId: admin.id,
      role: Role.admin,
      scopeType: RoleScopeType.faculty,
      scopeId: 'faculty',
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      validTo: new Date('2030-12-31T23:59:59.000Z'),
      createdBy: admin.id,
      isActive: true,
    },
  });

  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
