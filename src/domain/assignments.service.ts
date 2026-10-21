import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AssignmentStatus, FileCategory, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../common/storage.service';
import {
  assertValidUploadFile,
  generateObjectKey,
  sanitizeFileName,
} from '../common/file-validator.util';
import { AuthService } from '../auth/auth.service';
import { SafeUser } from '../common/user.util';
import { AssignmentDto, ExtendDeadlineDto, GradeDto } from './assignments.dto';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly auth: AuthService,
  ) {}

  private mapAssignment(a: any) {
    return {
      id: a.id,
      courseId: a.offering?.courseId || '',
      offeringId: a.offeringId,
      courseCode: a.offering?.course?.code || '',
      department: a.offering?.course?.department?.name || '',
      level: a.offering?.course ? String(a.offering.course.level) : '',
      title: a.title,
      instructions: a.instructions,
      dueDate: a.deadline.toISOString(),
      deadline: a.deadline.toISOString(),
      totalMarks: 100,
      createdAt: a.createdAt.toISOString(),
      status: a.status,
      allowedFileTypes: a.allowedTypes,
      maxSizeBytes: a.maxSizeBytes,
      allowLate: a.allowLate,
      lecturerIds: a.offering?.lecturers
        ? a.offering.lecturers.map((l: any) => l.userId)
        : [],
      studentDeadlineExtensions:
        (a.studentExtensions as Record<string, string>) || {},
    };
  }

  private mapSubmission(s: any, courseCode: string) {
    const sortedVersions = (s.versions || [])
      .slice()
      .sort((a: any, b: any) => a.version - b.version);
    const latestVersion =
      sortedVersions.length > 0
        ? sortedVersions[sortedVersions.length - 1]
        : null;

    const versions = sortedVersions.map((v: any) => ({
      version: v.version,
      fileUrl: `/api/v1/assignments/${s.assignmentId}/submissions/${s.id}/download`,
      fileName: v.fileName,
      fileSizeBytes: v.sizeBytes,
      sha256: v.sha256,
      submittedAt: v.submittedAt.toISOString(),
      isLate: v.isLate,
    }));

    const currentVersion = latestVersion
      ? {
          version: latestVersion.version,
          fileUrl: `/api/v1/assignments/${s.assignmentId}/submissions/${s.id}/download`,
          fileName: latestVersion.fileName,
          fileSizeBytes: latestVersion.sizeBytes,
          sha256: latestVersion.sha256,
          submittedAt: latestVersion.submittedAt.toISOString(),
          isLate: latestVersion.isLate,
        }
      : null;

    let status: 'submitted' | 'graded' | 'late' = 'submitted';
    if (s.score !== null && s.score !== undefined) {
      status = 'graded';
    } else if (latestVersion?.isLate) {
      status = 'late';
    }

    return {
      id: s.id,
      assignmentId: s.assignmentId,
      courseCode,
      studentId: s.studentId,
      studentName: s.student?.fullName || '',
      studentMatric: s.student?.matricNo || s.studentId,
      version: latestVersion ? latestVersion.version : 1,
      fileName: latestVersion ? latestVersion.fileName : '',
      fileUrl: `/api/v1/assignments/${s.assignmentId}/submissions/${s.id}/download`,
      fileSize: latestVersion ? latestVersion.sizeBytes : 0,
      submittedAt: latestVersion
        ? latestVersion.submittedAt.toISOString()
        : s.createdAt.toISOString(),
      isLate: latestVersion ? latestVersion.isLate : false,
      versions,
      currentVersion,
      score: s.score !== null ? s.score : undefined,
      feedback: s.feedback !== null ? s.feedback : undefined,
      status,
    };
  }

  async list(user: SafeUser, query: { courseCode?: string; tab?: string }) {
    const role = this.auth.effectiveRole(user);

    const assignments = await this.prisma.assignment.findMany({
      where:
        query.courseCode && query.courseCode !== 'all'
          ? { offering: { course: { code: query.courseCode } } }
          : undefined,
      include: {
        offering: {
          include: {
            course: { include: { department: true } },
            lecturers: true,
          },
        },
        submissions: {
          where: { studentId: user.id },
          include: { versions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    let items = assignments.filter(
      (a) =>
        a.status === AssignmentStatus.published || this.canManage(user, a),
    );

    if (role === Role.student || role === Role.course_rep) {
      const enrollments = await this.prisma.enrollment.findMany({
        where: { userId: user.id },
        select: { offeringId: true },
      });
      const enrolledSet = new Set(enrollments.map((e) => e.offeringId));
      items = items.filter((a) => enrolledSet.has(a.offeringId));
    }

    if (query.tab && query.tab !== 'all') {
      items = items.filter((assignment) => {
        const submission = assignment.submissions[0];
        const exts =
          (assignment.studentExtensions as Record<string, string>) || {};
        const due = new Date(exts[user.id] ?? assignment.deadline).getTime();
        const isGraded =
          submission?.score !== null && submission?.score !== undefined;

        if (query.tab === 'upcoming') return !submission && due >= Date.now();
        if (query.tab === 'submitted') return !!submission && !isGraded;
        if (query.tab === 'graded') return isGraded;
        if (query.tab === 'overdue') return !submission && due < Date.now();
        return true;
      });
    }

    return items.map((a) => this.mapAssignment(a));
  }

  async getLecturerStats(user: SafeUser) {
    const whereOffering =
      user.role === Role.lecturer
        ? { lecturers: { some: { userId: user.id } } }
        : user.departmentId
          ? { course: { departmentId: user.departmentId } }
          : {};

    const assignments = await this.prisma.assignment.findMany({
      where: { offering: whereOffering },
      include: {
        submissions: {
          select: {
            id: true,
            score: true,
          },
        },
      },
    });

    let totalSubmissions = 0;
    let pendingGrading = 0;
    let gradedCount = 0;

    for (const a of assignments) {
      for (const s of a.submissions) {
        totalSubmissions++;
        if (s.score === null || s.score === undefined) {
          pendingGrading++;
        } else {
          gradedCount++;
        }
      }
    }

    return {
      totalAssignments: assignments.length,
      totalSubmissions,
      pendingGrading,
      gradedCount,
    };
  }

  async get(id: string, user: SafeUser) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id },
      include: {
        offering: {
          include: {
            course: { include: { department: true } },
            lecturers: true,
          },
        },
        submissions: {
          where: { studentId: user.id },
          include: { student: true, versions: true },
        },
      },
    });

    if (!assignment) throw new NotFoundException('Assignment not found');

    const mapped = this.mapAssignment(assignment);
    const ownSubmission = assignment.submissions[0]
      ? this.mapSubmission(assignment.submissions[0], mapped.courseCode)
      : undefined;

    return { ...mapped, ownSubmission };
  }

  async create(user: SafeUser, dto: AssignmentDto) {
    const offering = await this.prisma.offering.findUnique({
      where: { id: dto.offeringId },
      include: { course: true, lecturers: true },
    });

    if (!offering) throw new BadRequestException('Course offering not found');

    const role = this.auth.effectiveRole(user);
    if (
      role === Role.lecturer &&
      !offering.lecturers.some((l) => l.userId === user.id)
    ) {
      throw new ForbiddenException(
        'You are not assigned to this course offering',
      );
    }
    if (
      role === Role.hod &&
      user.departmentId &&
      offering.course.departmentId !== user.departmentId
    ) {
      throw new ForbiddenException(
        'HOD can only create assignments in their department',
      );
    }

    const assignment = await this.prisma.assignment.create({
      data: {
        offeringId: dto.offeringId,
        title: dto.title,
        instructions: dto.instructions,
        deadline: new Date(dto.dueDate),
        allowLate: dto.allowLate ?? false,
        allowedTypes: dto.allowedFileTypes || [],
        maxSizeBytes: dto.maxSizeBytes || 10485760,
        status:
          (dto.status as AssignmentStatus) || AssignmentStatus.published,
      },
      include: {
        offering: {
          include: {
            course: { include: { department: true } },
            lecturers: true,
          },
        },
      },
    });

    await this.audit.log(
      user,
      'CREATE_ASSIGNMENT',
      'Assignment',
      assignment.id,
      assignment.title,
    );
    return this.mapAssignment(assignment);
  }

  async submit(id: string, user: SafeUser, file: Express.Multer.File) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('A valid submission file is required');
    }

    const assignment = await this.prisma.assignment.findUnique({
      where: { id },
      include: {
        offering: {
          include: {
            course: { include: { department: true } },
          },
        },
      },
    });

    if (!assignment) throw new NotFoundException('Assignment not found');

    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        offeringId_userId: {
          offeringId: assignment.offeringId,
          userId: user.id,
        },
      },
    });

    if (!enrollment) {
      throw new ForbiddenException(
        'You are not enrolled in this course offering',
      );
    }

    // Validate file size, allowed extensions, and magic-byte signature
    const sig = assertValidUploadFile({
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
      maxSizeBytes: assignment.maxSizeBytes,
      allowedExtensions: assignment.allowedTypes,
    });

    const exts =
      (assignment.studentExtensions as Record<string, string>) || {};
    const due = new Date(exts[user.id] ?? assignment.deadline).getTime();
    const isLate = Date.now() > due;

    if (isLate && !assignment.allowLate) {
      throw new ForbiddenException(
        'Submission is locked because the deadline has passed',
      );
    }

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const safeName = sanitizeFileName(file.originalname);
    const fileKey = generateObjectKey(
      'submissions',
      safeName,
      `${assignment.id}/${user.id}`,
    );

    // Store file in StorageService (local disk in dev, S3/R2 in prod)
    await this.storage.putObject(fileKey, file.buffer, sig.detectedMimeType);

    const now = new Date();

    try {
      // Transaction to upsert submission, create version, and record StoredFile metadata
      const { submission, versionRecord } = await this.prisma.$transaction(
        async (tx) => {
          let sub = await tx.submission.findUnique({
            where: {
              assignmentId_studentId: {
                assignmentId: id,
                studentId: user.id,
              },
            },
            include: { versions: true },
          });

          if (!sub) {
            sub = await tx.submission.create({
              data: {
                assignmentId: id,
                studentId: user.id,
              },
              include: { versions: true },
            });
          } else {
            // Reset score/feedback on new submission version
            sub = await tx.submission.update({
              where: { id: sub.id },
              data: {
                score: null,
                feedback: null,
              },
              include: { versions: true },
            });
          }

          const nextVersion = sub.versions.length + 1;
          const version = await tx.submissionVersion.create({
            data: {
              submissionId: sub.id,
              version: nextVersion,
              fileKey,
              fileName: safeName,
              sizeBytes: file.buffer.length,
              mimeType: sig.detectedMimeType,
              sha256: checksum,
              submittedAt: now,
              isLate,
            },
          });

          if ((tx as any).storedFile) {
            await (tx as any).storedFile.create({
              data: {
                fileKey,
                fileName: safeName,
                mimeType: sig.detectedMimeType,
                sizeBytes: file.buffer.length,
                sha256: checksum,
                category: FileCategory.assignment_submission,
                uploaderId: user.id,
                linkedRecordId: version.id,
                storageDriver:
                  typeof (this.storage as any).getDriverName === 'function'
                    ? (this.storage as any).getDriverName()
                    : 'disk',
              },
            });
          }

          const fullSub = await tx.submission.findUniqueOrThrow({
            where: { id: sub.id },
            include: {
              student: true,
              versions: { orderBy: { version: 'asc' } },
            },
          });

          return { submission: fullSub, versionRecord: version };
        },
      );

      const mapped = this.mapSubmission(
        submission,
        assignment.offering.course.code,
      );

      return {
        ...mapped,
        receipt: {
          receiptId: randomUUID(),
          submissionId: submission.id,
          fileName: versionRecord.fileName,
          fileSizeBytes: versionRecord.sizeBytes,
          sha256: checksum,
          serverTimestamp: now.toISOString(),
        },
      };
    } catch (err) {
      // Clean up uploaded object if DB transaction fails
      if (typeof this.storage.deleteObject === 'function') {
        await this.storage.deleteObject(fileKey);
      }
      throw err;
    }
  }

  async submissions(assignmentId: string, user: SafeUser) {
    const role = this.auth.effectiveRole(user);
    if (role === Role.course_rep) {
      throw new ForbiddenException(
        'Course representatives cannot access submission files',
      );
    }

    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        offering: {
          include: {
            course: true,
            lecturers: true,
          },
        },
      },
    });

    if (!assignment) throw new NotFoundException('Assignment not found');

    if (role === Role.student) {
      const userSubs = await this.prisma.submission.findMany({
        where: { assignmentId, studentId: user.id },
        include: { student: true, versions: true },
      });
      return userSubs.map((s) =>
        this.mapSubmission(s, assignment.offering.course.code),
      );
    }

    if (!this.canManage(user, assignment)) {
      throw new ForbiddenException(
        'You are not assigned to this course offering',
      );
    }

    const subs = await this.prisma.submission.findMany({
      where: { assignmentId },
      include: { student: true, versions: true },
    });

    return subs.map((s) =>
      this.mapSubmission(s, assignment.offering.course.code),
    );
  }

  async grade(id: string, user: SafeUser, dto: GradeDto) {
    const submission = await this.prisma.submission.findUnique({
      where: { id },
      include: {
        student: true,
        assignment: {
          include: {
            offering: {
              include: {
                course: true,
                lecturers: true,
              },
            },
          },
        },
      },
    });

    if (!submission) throw new NotFoundException('Submission not found');
    if (!this.canManage(user, submission.assignment)) {
      throw new ForbiddenException('You cannot grade this submission');
    }

    const totalMarks = 100;
    if (dto.score > totalMarks) {
      throw new BadRequestException(`Score cannot exceed ${totalMarks}`);
    }

    const updated = await this.prisma.submission.update({
      where: { id },
      data: {
        score: dto.score,
        feedback: dto.feedback || null,
      },
      include: {
        student: true,
        versions: true,
      },
    });

    await this.audit.log(
      user,
      'GRADE_SUBMISSION',
      'Submission',
      id,
      submission.student.matricNo || submission.student.fullName,
    );

    return this.mapSubmission(
      updated,
      submission.assignment.offering.course.code,
    );
  }

  async extend(id: string, user: SafeUser, dto: ExtendDeadlineDto) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id },
      include: {
        offering: {
          include: {
            course: true,
            lecturers: true,
          },
        },
      },
    });

    if (!assignment) throw new NotFoundException('Assignment not found');
    if (!this.canManage(user, assignment)) {
      throw new ForbiddenException('You cannot extend this deadline');
    }

    const extensions =
      (assignment.studentExtensions as Record<string, string>) || {};
    let updatedAssignment: any;

    if (dto.studentId) {
      extensions[dto.studentId] = dto.dueDate;
      updatedAssignment = await this.prisma.assignment.update({
        where: { id },
        data: { studentExtensions: extensions },
        include: {
          offering: {
            include: {
              course: { include: { department: true } },
              lecturers: true,
            },
          },
        },
      });
    } else {
      updatedAssignment = await this.prisma.assignment.update({
        where: { id },
        data: { deadline: new Date(dto.dueDate) },
        include: {
          offering: {
            include: {
              course: { include: { department: true } },
              lecturers: true,
            },
          },
        },
      });
    }

    await this.audit.log(
      user,
      'EXTEND_DEADLINE',
      'Assignment',
      id,
      assignment.title,
      dto.reason,
    );

    return this.mapAssignment(updatedAssignment);
  }

  async headcount(id: string, user: SafeUser) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id },
      include: {
        offering: {
          include: {
            course: { include: { department: true } },
            lecturers: true,
            enrollments: {
              include: { user: true },
            },
          },
        },
        submissions: {
          include: {
            student: true,
            versions: { orderBy: { version: 'desc' } },
          },
        },
      },
    });

    if (!assignment) throw new NotFoundException('Assignment not found');

    const role = this.auth.effectiveRole(user);
    if (role === Role.student) {
      throw new ForbiddenException('Students cannot view headcount details');
    }
    if (role === Role.course_rep) {
      const isEnrolled = assignment.offering.enrollments.some(
        (e) => e.userId === user.id,
      );
      if (!isEnrolled) {
        throw new ForbiddenException(
          'Course representatives can only view headcount for enrolled courses',
        );
      }
    } else if (!this.canManage(user, assignment)) {
      throw new ForbiddenException(
        'You are not authorized to view headcount for this assignment',
      );
    }

    const students = assignment.offering.enrollments.map((e) => e.user);
    const submissions = assignment.submissions;

    return {
      total: students.length,
      submittedCount: submissions.length,
      submitted: submissions.map((s) => ({
        name: s.student.fullName,
        matric: s.student.matricNo || s.student.id,
        submittedAt:
          s.versions[0]?.submittedAt.toISOString() ||
          s.createdAt.toISOString(),
      })),
      notSubmitted: students
        .filter((st) => !submissions.some((sub) => sub.studentId === st.id))
        .map((st) => ({
          name: st.fullName,
          matric: st.matricNo || st.id,
        })),
    };
  }

  async getSubmissionFile(
    assignmentId: string,
    submissionId: string,
    user: SafeUser,
  ) {
    const role = this.auth.effectiveRole(user);
    if (role === Role.course_rep) {
      throw new ForbiddenException(
        'Course representatives cannot access submission files',
      );
    }

    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        assignment: {
          include: {
            offering: {
              include: {
                lecturers: true,
                course: { include: { department: true } },
              },
            },
          },
        },
        student: true,
        versions: { orderBy: { version: 'desc' } },
      },
    });

    if (!submission) throw new NotFoundException('Submission not found');
    if (assignmentId && submission.assignmentId !== assignmentId) {
      throw new NotFoundException('Submission not found for this assignment');
    }

    if (role === Role.student && submission.studentId !== user.id) {
      throw new ForbiddenException(
        "You cannot download another student's submission",
      );
    }

    if (role === Role.lecturer) {
      const isAssigned = submission.assignment.offering.lecturers.some(
        (l) => l.userId === user.id,
      );
      if (!isAssigned) {
        throw new ForbiddenException(
          'You are not assigned to this course offering',
        );
      }
    }

    if (role === Role.hod) {
      const deptId = submission.assignment.offering.course.departmentId;
      if (user.departmentId && deptId !== user.departmentId) {
        throw new ForbiddenException(
          'HOD cannot access submissions outside their department',
        );
      }
    }

    const latestVersion = submission.versions[0];
    if (!latestVersion) {
      throw new NotFoundException('Submission has no uploaded files');
    }

    const fileBuffer = await this.storage.getObject(latestVersion.fileKey);
    return {
      buffer: fileBuffer,
      fileName: latestVersion.fileName,
      mimeType: latestVersion.mimeType,
      sizeBytes: latestVersion.sizeBytes,
    };
  }

  private canManage(user: SafeUser, assignment: any) {
    const role = this.auth.effectiveRole(user);
    if (role === Role.admin) return true;
    if (role === Role.hod) {
      const deptId = assignment.offering?.course?.departmentId;
      return Boolean(
        user.departmentId && deptId && deptId === user.departmentId,
      );
    }
    if (role === Role.lecturer) {
      const lecturerIds =
        assignment.offering?.lecturers?.map((l: any) => l.userId) || [];
      return lecturerIds.includes(user.id);
    }
    return false;
  }
}
