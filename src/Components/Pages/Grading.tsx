import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../interceptor';
import { evaluateSubmissionWithAi } from '../../Services/aiService';
import { examServices } from '../../Services/examServices';
import { GradingServices } from '../../Services/gradingServices';
import { questionServices } from '../../Services/questionServices';
import '../../Styles/Grading.css';

const PARTICIPANT_TYPE = {
  Online: 1,
  Offline: 2,
} as const;

const resolveBackendFileUrl = (relativeOrFullUrl?: string | null): string => {
  if (!relativeOrFullUrl) return '';
  if (/^https?:\/\//i.test(relativeOrFullUrl)) return relativeOrFullUrl;

  const baseUrl = api.defaults.baseURL || '';
  const serverOrigin = baseUrl.replace(/\/api\/?$/i, '').replace(/\/$/, '');
  const normalizedPath = relativeOrFullUrl.startsWith('/')
    ? relativeOrFullUrl
    : `/${relativeOrFullUrl}`;

  return `${serverOrigin}${normalizedPath}`;
};

const extractErrorText = (err: any, fallback: string): string => {
  const data = err?.response?.data;
  if (data && typeof data === 'object' && typeof data.message === 'string') {
    return data.message;
  }
  if (typeof data === 'string' && data.trim().length > 0) {
    return data;
  }
  if (typeof err?.message === 'string' && err.message.trim().length > 0) {
    return err.message;
  }
  return fallback;
};

const getQuestionTitleText = (q: any, idx: number): string => {
  const rawTitle =
    q?.questionTitle ??
    q?.QuestionTitle ??
    q?.title ??
    q?.Title ??
    q?.questionText ??
    q?.QuestionText ??
    q?.prompt ??
    q?.Prompt ??
    '';
  const cleaned = String(rawTitle ?? '').trim();
  return cleaned.length > 0 ? cleaned : `Question ${idx + 1}`;
};

const getQuestionDescText = (q: any): string => {
  const rawDesc =
    q?.questionDescription ??
    q?.QuestionDescription ??
    q?.description ??
    q?.Description ??
    '';
  return String(rawDesc ?? '').trim();
};

const normalizeQuestionItem = (q: any, idx: number) => {
  const dbId = Number(q?.questionId ?? q?.QuestionId ?? q?.id ?? q?.Id ?? 0);
  const hasDbId = Number.isFinite(dbId) && dbId > 0;
  // Positive IDs are real DB Question IDs; negative fallback IDs keep local UI controls responsive
  const stateKey = hasDbId ? dbId : -(idx + 1);
  const rawMax = Number(q?.maxMarks ?? q?.MaxMarks ?? q?.marks ?? q?.Marks ?? 5);
  const maxMarks = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 5;
  const rawAwarded = Number(q?.awardedMarks ?? q?.AwardedMarks ?? 0);
  const awardedMarks = Number.isFinite(rawAwarded) ? rawAwarded : 0;
  const reasonOfMarking = String(q?.reasonOfMarking ?? q?.ReasonOfMarking ?? '');

  return {
    ...q,
    _stateKey: stateKey,
    _dbQuestionId: hasDbId ? dbId : null,
    _title: getQuestionTitleText(q, idx),
    _description: getQuestionDescText(q),
    _maxMarks: maxMarks,
    _awardedMarks: awardedMarks,
    _reason: reasonOfMarking,
  };
};

const fetchQuestionPaperFallback = async (
  examId?: number | null,
  preferredSetId?: number | null
): Promise<{ questions: any[]; setName: string }> => {
  if (!examId) return { questions: [], setName: '' };
  try {
    const sets = await questionServices.getSetsByExam(Number(examId));
    if (!Array.isArray(sets) || sets.length === 0) return { questions: [], setName: '' };

    const matchedSet =
      (preferredSetId != null
        ? sets.find((s: any) => Number(s.id ?? s.Id) === Number(preferredSetId))
        : null) || sets[0];

    const setId = Number((matchedSet as any)?.id ?? (matchedSet as any)?.Id);
    const setName = String((matchedSet as any)?.name ?? (matchedSet as any)?.Name ?? '');
    if (!setId) return { questions: [], setName };

    const qs = await questionServices.getQuestionsBySet(setId);
    if (!Array.isArray(qs)) return { questions: [], setName };

    const questions = qs.map((q: any, idx: number) =>
      normalizeQuestionItem(
        {
          questionId: q.id ?? q.Id,
          questionTitle: getQuestionTitleText(q, idx),
          questionDescription: getQuestionDescText(q),
          questionType: q.type ?? q.Type,
          maxMarks: Number(q.marks ?? q.Marks ?? 5),
          awardedMarks: 0,
          reasonOfMarking: '',
        },
        idx
      )
    );

    return { questions, setName };
  } catch {
    return { questions: [], setName: '' };
  }
};

export const Grading: React.FC = () => {
  const [exams, setExams] = useState<any[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<number | ''>('');
  const [submissions, setSubmissions] = useState<any[]>([]);

  const [loadingExams, setLoadingExams] = useState<boolean>(false);
  const [loadingSubmissions, setLoadingSubmissions] = useState<boolean>(false);
  const [loadingSubmissionId, setLoadingSubmissionId] = useState<number | null>(null);
  const [savingAction, setSavingAction] = useState<boolean>(false);
  const [aiEvaluating, setAiEvaluating] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Active grading workspace state
  const [activeParticipantId, setActiveParticipantId] = useState<number | null>(null);
  const [gradingPaper, setGradingPaper] = useState<any | null>(null);
  const [marksMap, setMarksMap] = useState<{ [key: number]: { marks: number; reason: string } }>({});
  const [offlineOverallScore, setOfflineOverallScore] = useState<number>(0);
  const [offlineFeedback, setOfflineFeedback] = useState<string>('');
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<string | null>(null);

  const requestSeqRef = useRef<number>(0);
  const submissionsSeqRef = useRef<number>(0);

  useEffect(() => {
    let isMounted = true;
    const fetchFacultyExams = async () => {
      try {
        setLoadingExams(true);
        const data = await examServices.getMyExams();
        if (!isMounted) return;
        const examArray = Array.isArray(data) ? data : [];
        setExams(examArray);
        if (examArray.length > 0) {
          setSelectedExamId(examArray[0].id);
        }
      } catch (err: any) {
        if (!isMounted) return;
        setError(extractErrorText(err, 'Failed to load faculty exams.'));
      } finally {
        if (isMounted) setLoadingExams(false);
      }
    };
    fetchFacultyExams();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleLoadSubmissions = async () => {
    if (!selectedExamId) return;
    const seq = ++submissionsSeqRef.current;
    try {
      setLoadingSubmissions(true);
      setError(null);
      setMessage(null);
      const data = await GradingServices.getPendingSubmissions(Number(selectedExamId));
      if (seq !== submissionsSeqRef.current) return;
      const subsArray = Array.isArray(data) ? data : [];
      setSubmissions(subsArray);
    } catch (err: any) {
      if (seq !== submissionsSeqRef.current) return;
      setError(extractErrorText(err, 'Failed to load submissions for grading.'));
      setSubmissions([]);
    } finally {
      if (seq === submissionsSeqRef.current) {
        setLoadingSubmissions(false);
      }
    }
  };

  // ResultStatus enum: 1 = Inactive, 2 = Processing, 3 = Published, 4 = Suspended
  const publishedCount = submissions.filter(sub => (sub.resultStatus ?? sub.ResultStatus) === 3).length;
  const pendingCount = Math.max(0, submissions.length - publishedCount);

  const getResultStatusLabel = (status?: number) => {
    switch (status) {
      case 2:
        return 'Draft Saved (Not Published)';
      case 3:
        return 'Published';
      case 4:
        return 'Suspended';
      default:
        return 'Pending Evaluation';
    }
  };

  const applyPaperToWorkspace = (
    participantId: number,
    paperData: any,
    rawQuestions: any[],
    resolvedSetName: string,
    matchedSub: any
  ) => {
    const normalizedQuestions = (Array.isArray(rawQuestions) ? rawQuestions : []).map((q, idx) =>
      normalizeQuestionItem(q, idx)
    );

    const initialMap: { [key: number]: { marks: number; reason: string } } = {};
    let sumExistingMarks = 0;
    const existingReasons: string[] = [];

    normalizedQuestions.forEach(q => {
      initialMap[q._stateKey] = {
        marks: q._awardedMarks,
        reason: q._reason,
      };
      sumExistingMarks += q._awardedMarks;
      if (q._reason) existingReasons.push(q._reason);
    });

    setGradingPaper({
      ...paperData,
      setName: resolvedSetName,
      questions: normalizedQuestions,
    });
    setMarksMap(initialMap);
    setOfflineOverallScore(
      Number(matchedSub?.totalMarks ?? matchedSub?.TotalMarks ?? sumExistingMarks ?? 0)
    );
    setOfflineFeedback(existingReasons.join(' | '));
    setActiveParticipantId(participantId);
  };

  const handleOpenGradingWorkspace = async (participantId: number) => {
    const seq = ++requestSeqRef.current;

    const matchedSub = submissions.find(
      s => (s.participantId ?? s.ParticipantId) === participantId
    );
    const fallbackPdfUrl =
      matchedSub?.pdfAnswerSheetURL ?? matchedSub?.PdfAnswerSheetURL ?? '';
    const fallbackType = Number(
      matchedSub?.participantType ?? matchedSub?.ParticipantType ?? PARTICIPANT_TYPE.Online
    );
    const currentExamObj = exams.find(e => Number(e.id) === Number(selectedExamId));
    const currentExamId = Number(selectedExamId) || null;
    const preferredSetId = matchedSub?.setId ?? matchedSub?.SetId ?? null;
    const matchedSetName = matchedSub?.setName ?? matchedSub?.SetName ?? '';

    try {
      setError(null);
      setLastDraftSavedAt(null);
      setLoadingSubmissionId(participantId);

      const paper: any = await GradingServices.getSubmissionForGrading(participantId);
      if (seq !== requestSeqRef.current) return;

      let rawQuestions: any[] = paper?.questions ?? paper?.Questions ?? [];
      let resolvedSetName: string =
        paper?.setName ?? paper?.SetName ?? paper?.questionSetName ?? paper?.QuestionSetName ?? matchedSetName ?? '';

      if (rawQuestions.length === 0) {
        const paperExamId = Number(paper?.examId ?? paper?.ExamId ?? currentExamId ?? 0) || null;
        const paperSetId = paper?.setId ?? paper?.SetId ?? preferredSetId;
        const fallbackResult = await fetchQuestionPaperFallback(paperExamId, paperSetId);
        if (seq !== requestSeqRef.current) return;
        rawQuestions = fallbackResult.questions;
        if (!resolvedSetName && fallbackResult.setName) {
          resolvedSetName = fallbackResult.setName;
        }
      }

      applyPaperToWorkspace(
        participantId,
        {
          ...paper,
          examName: paper?.examName ?? paper?.ExamName ?? currentExamObj?.name ?? 'Exam',
        },
        rawQuestions,
        resolvedSetName,
        matchedSub
      );
    } catch (err: any) {
      if (seq !== requestSeqRef.current) return;
      const errMsg = extractErrorText(err, 'Failed to load participant answer sheet.');

      if (fallbackPdfUrl || fallbackType === PARTICIPANT_TYPE.Offline) {
        const fallbackResult = await fetchQuestionPaperFallback(currentExamId, preferredSetId);
        if (seq !== requestSeqRef.current) return;

        applyPaperToWorkspace(
          participantId,
          {
            participantId,
            studentName: matchedSub?.studentName ?? matchedSub?.StudentName ?? `Student #${participantId}`,
            studentEmail: matchedSub?.studentEmail ?? matchedSub?.StudentEmail ?? '',
            examName: currentExamObj?.name ?? 'Offline Exam',
            examMaxMarks: currentExamObj?.maxMarks ?? 100,
            participantType: PARTICIPANT_TYPE.Offline,
            pdfAnswerSheetURL: fallbackPdfUrl,
          },
          fallbackResult.questions,
          matchedSetName || fallbackResult.setName || '',
          matchedSub
        );
        setError(`${errMsg} Opened PDF answer sheet in fallback mode.`);
      } else {
        setError(errMsg);
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setLoadingSubmissionId(null);
      }
    }
  };

  const handleMarkChange = (
    stateKey: number,
    field: 'marks' | 'reason',
    value: number | string,
    maxLimit?: number
  ) => {
    const keyNum = Number(stateKey);
    if (!Number.isFinite(keyNum) || keyNum === 0) return;

    setMarksMap(prev => {
      const currentEntry = prev[keyNum];
      let nextMarks = Number(currentEntry?.marks ?? 0);
      if (Number.isNaN(nextMarks)) nextMarks = 0;

      if (field === 'marks') {
        const parsed = Number(value);
        const safeNum = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
        nextMarks = typeof maxLimit === 'number' ? Math.min(maxLimit, safeNum) : safeNum;
      }

      return {
        ...prev,
        [keyNum]: {
          marks: nextMarks,
          reason: field === 'reason' ? String(value) : String(currentEntry?.reason ?? ''),
        },
      };
    });
  };

  const questionsList: any[] = gradingPaper?.questions ?? gradingPaper?.Questions ?? [];
  const examMaxCap = Number(gradingPaper?.examMaxMarks ?? gradingPaper?.ExamMaxMarks ?? 100) || 100;

  const handleOfflineScoreChange = (rawVal: number | string) => {
    const parsed = Number(rawVal);
    const safeNum = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
    setOfflineOverallScore(Math.min(examMaxCap, safeNum));
  };

  const buildEvaluationPayload = (participantId: number) => {
    const evaluations: Array<{
      questionId: number;
      marks: number;
      awardedMarks: number;
      reasonOfMarking: string;
    }> = [];

    questionsList.forEach((q: any) => {
      const dbQId = Number(q?._dbQuestionId ?? q?.questionId ?? q?.QuestionId ?? q?.id ?? q?.Id ?? 0);
      if (!Number.isFinite(dbQId) || dbQId <= 0) return;

      const entry = marksMap[q._stateKey];
      const safeMarks = Number(entry?.marks ?? 0);
      const validMarks = Number.isNaN(safeMarks) ? 0 : safeMarks;

      evaluations.push({
        questionId: dbQId,
        marks: validMarks,
        awardedMarks: validMarks,
        reasonOfMarking: String(entry?.reason ?? ''),
      });
    });

    if (evaluations.length === 0 && questionsList.length > 0) {
      const firstDbId = Number(
        questionsList[0]?._dbQuestionId ??
          questionsList[0]?.questionId ??
          questionsList[0]?.QuestionId ??
          questionsList[0]?.id ??
          questionsList[0]?.Id ??
          0
      );
      if (Number.isFinite(firstDbId) && firstDbId > 0) {
        const safeScore = Number.isNaN(Number(offlineOverallScore)) ? 0 : Number(offlineOverallScore);
        evaluations.push({
          questionId: firstDbId,
          marks: safeScore,
          awardedMarks: safeScore,
          reasonOfMarking: offlineFeedback.trim() || 'Offline Answer Sheet Evaluation',
        });
      }
    }

    return {
      participantId,
      evaluations,
    };
  };

  const handleSaveEvaluation = async (participantId: number) => {
    try {
      setSavingAction(true);
      setError(null);
      const payload = buildEvaluationPayload(participantId);
      if (payload.evaluations.length > 0) {
        const res = await GradingServices.saveEvaluation(payload as any);
        setMessage(res?.message || 'Draft marks saved. Click "Submit & Grade" to release results to the student.');
      } else {
        setMessage('No question items found on this exam to save to Results table; click "Submit & Grade" to publish.');
      }
      setLastDraftSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

      setSubmissions(prev =>
        prev.map(sub => {
          const pId = sub.participantId ?? sub.ParticipantId;
          return pId === participantId ? { ...sub, resultStatus: 2, ResultStatus: 2 } : sub;
        })
      );
    } catch (err: any) {
      setError(extractErrorText(err, 'Failed to save evaluation marks.'));
    } finally {
      setSavingAction(false);
    }
  };

  const handleEvaluateWithAi = async (participantId: number) => {
    try {
      setAiEvaluating(true);
      setError(null);
      setMessage(null);

      await evaluateSubmissionWithAi(participantId, isOfflineSubmission);
      await handleOpenGradingWorkspace(participantId);

      setSubmissions(prev =>
        prev.map(sub => {
          const pId = sub.participantId ?? sub.ParticipantId;
          return pId === participantId ? { ...sub, resultStatus: 2, ResultStatus: 2 } : sub;
        })
      );

      setLastDraftSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setMessage('AI evaluation completed and saved as draft. Review scores and click "Submit & Grade" to publish.');
    } catch (err: any) {
      setError(extractErrorText(err, 'Failed to run AI evaluation.'));
    } finally {
      setAiEvaluating(false);
    }
  };

  const handleFinalizeAndPublish = async (participantId: number) => {
    if (!window.confirm('Are you sure you want to finalize and publish results for this student?')) return;
    try {
      setSavingAction(true);
      setError(null);

      const payload = buildEvaluationPayload(participantId);
      if (payload.evaluations.length > 0) {
        await GradingServices.saveEvaluation(payload as any);
      }

      const res = await GradingServices.finalizeAndPublishResult(participantId);
      const publishedScore =
        questionsList.length === 0 && isOfflineSubmission
          ? (res?.totalMarks ?? offlineOverallScore)
          : (res?.totalMarks ?? subTotalFallback);

      setMessage(res?.message || 'Result finalized and published successfully.');

      setSubmissions(prev =>
        prev.map(sub => {
          const pId = sub.participantId ?? sub.ParticipantId;
          return pId === participantId
            ? {
                ...sub,
                resultStatus: 3,
                ResultStatus: 3,
                totalMarks: publishedScore ?? sub.totalMarks,
                grade: res?.grade ?? sub.grade,
              }
            : sub;
        })
      );
      setActiveParticipantId(null);
    } catch (err: any) {
      setError(extractErrorText(err, 'Failed to publish result.'));
    } finally {
      setSavingAction(false);
    }
  };

  const { totalAwardedScore, totalQuestionMaxScore, subTotalFallback } = useMemo(() => {
    let awarded = 0;
    let maxTotal = 0;
    questionsList.forEach((q: any) => {
      const qMax = Number(q?._maxMarks ?? q?.maxMarks ?? q?.MaxMarks ?? 0);
      maxTotal += Number.isNaN(qMax) ? 0 : qMax;
      const mVal = Number(marksMap[q._stateKey]?.marks ?? 0);
      awarded += Number.isNaN(mVal) ? 0 : mVal;
    });

    const hasQuestions = questionsList.length > 0;
    return {
      totalAwardedScore: hasQuestions ? Number(awarded.toFixed(2)) : Number(offlineOverallScore.toFixed(2)),
      totalQuestionMaxScore: hasQuestions ? maxTotal : examMaxCap,
      subTotalFallback: hasQuestions ? Number(awarded.toFixed(2)) : Number(offlineOverallScore.toFixed(2)),
    };
  }, [questionsList, marksMap, offlineOverallScore, examMaxCap]);

  const activeSubmissionMeta = useMemo(
    () => submissions.find(s => (s.participantId ?? s.ParticipantId) === activeParticipantId),
    [submissions, activeParticipantId]
  );

  const activeSubmissionIndex = useMemo(
    () => submissions.findIndex(s => (s.participantId ?? s.ParticipantId) === activeParticipantId),
    [submissions, activeParticipantId]
  );

  const rawPdfUrl =
    gradingPaper?.pdfAnswerSheetURL ??
    gradingPaper?.PdfAnswerSheetURL ??
    activeSubmissionMeta?.pdfAnswerSheetURL ??
    activeSubmissionMeta?.PdfAnswerSheetURL ??
    '';

  const participantType = Number(
    gradingPaper?.participantType ??
      gradingPaper?.ParticipantType ??
      activeSubmissionMeta?.participantType ??
      activeSubmissionMeta?.ParticipantType ??
      PARTICIPANT_TYPE.Online
  );

  const isOfflineSubmission = participantType === PARTICIPANT_TYPE.Offline || Boolean(rawPdfUrl);
  const resolvedPdfUrl = resolveBackendFileUrl(rawPdfUrl);
  const pdfFileName = rawPdfUrl ? rawPdfUrl.split('/').pop() : `Submission_ID_${activeParticipantId}.pdf`;
  const iframeSrc = resolvedPdfUrl
    ? `${resolvedPdfUrl}#toolbar=0&navpanes=0`
    : '';

  const headerExamName =
    gradingPaper?.examName ??
    gradingPaper?.ExamName ??
    exams.find(e => Number(e.id) === Number(selectedExamId))?.name ??
    'Exam';

  const headerQuestionSet =
    gradingPaper?.setName ??
    gradingPaper?.SetName ??
    activeSubmissionMeta?.setName ??
    activeSubmissionMeta?.SetName ??
    '';

  const handleNavigateSubmission = (direction: -1 | 1) => {
    const nextIndex = activeSubmissionIndex + direction;
    if (nextIndex >= 0 && nextIndex < submissions.length) {
      const nextSub = submissions[nextIndex];
      const nextId = nextSub.participantId ?? nextSub.ParticipantId;
      if (nextId) {
        handleOpenGradingWorkspace(nextId);
      }
    }
  };

  const isBusy = savingAction || aiEvaluating;

  return (
    <div className="manage-page">
      <h2>Faculty Grading & Evaluation Portal</h2>

      {message && <p className="manage-success">{message}</p>}
      {error && <p className="manage-error">{error}</p>}

      {/* Load Exam Submissions Section */}
      <div className="manage-card" style={{ marginBottom: '20px' }}>
        <h3>Load Exam Submissions</h3>
        <div className="manage-row" style={{ alignItems: 'flex-end', gap: '15px' }}>
          <div style={{ flex: 1 }}>
            <label><strong>Select Exam:</strong></label>
            <select
              value={selectedExamId}
              onChange={e => setSelectedExamId(Number(e.target.value))}
              style={{ width: '100%', padding: '10px', borderRadius: '8px', marginTop: '5px' }}
              disabled={loadingExams}
            >
              {exams.map(ex => (
                <option key={ex.id} value={ex.id}>{ex.name} (ID: {ex.id})</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={handleLoadSubmissions}
            className="manage-btn manage-btn--primary"
            style={{ padding: '11px 22px' }}
          >
            {loadingSubmissions ? 'Loading...' : 'Load Submissions'}
          </button>
        </div>
      </div>

      {/* Evaluation Status Summary Counter Banner */}
      {submissions.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '15px', marginBottom: '20px' }}>
          <div style={{ background: 'rgba(255, 243, 205, 0.7)', padding: '15px', borderRadius: '12px', border: '1px solid rgba(255, 193, 7, 0.3)' }}>
            <span style={{ fontSize: '0.85rem', color: '#856404', display: 'block' }}>Unpublished / Pending</span>
            <strong style={{ fontSize: '1.4rem', color: '#856404' }}>{pendingCount} Submissions</strong>
          </div>
          <div style={{ background: 'rgba(212, 237, 218, 0.7)', padding: '15px', borderRadius: '12px', border: '1px solid rgba(40, 167, 69, 0.3)' }}>
            <span style={{ fontSize: '0.85rem', color: '#155724', display: 'block' }}>Published Results</span>
            <strong style={{ fontSize: '1.4rem', color: '#155724' }}>{publishedCount} Submissions</strong>
          </div>
        </div>
      )}

      {/* Submissions List Section */}
      <div className="manage-card">
        <h3>Submissions & Answer Sheets</h3>
        {submissions.length === 0 ? (
          <p style={{ fontStyle: 'italic', color: '#6b6252', padding: '10px 0' }}>
            {loadingSubmissions ? 'Fetching candidate answers...' : 'Click "Load Submissions" to view participant answer sheets from the database.'}
          </p>
        ) : (
          <ul className="manage-list">
            {submissions.map((sub: any) => {
              const pId = sub.participantId ?? sub.ParticipantId;
              const sName = sub.studentName ?? sub.StudentName ?? `Student #${pId}`;
              const sEmail = sub.studentEmail ?? sub.StudentEmail ?? '';
              const rStatus = sub.resultStatus ?? sub.ResultStatus;
              const isPublished = rStatus === 3;
              const subType = Number(sub.participantType ?? sub.ParticipantType ?? PARTICIPANT_TYPE.Online);
              const isSubOffline = subType === PARTICIPANT_TYPE.Offline || Boolean(sub.pdfAnswerSheetURL ?? sub.PdfAnswerSheetURL);
              const isOpeningThis = loadingSubmissionId === pId;

              return (
                <li key={pId} className="manage-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', background: 'rgba(255,255,255,0.6)', marginBottom: '10px', borderRadius: '10px' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <h4 style={{ margin: 0 }}>{sName}</h4>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '2px 9px',
                          borderRadius: '999px',
                          background: isSubOffline ? 'rgba(180, 83, 9, 0.12)' : 'rgba(46, 125, 50, 0.12)',
                          color: isSubOffline ? '#b45309' : '#2e7d32',
                          border: isSubOffline ? '1px solid rgba(180, 83, 9, 0.25)' : '1px solid rgba(46, 125, 50, 0.25)',
                        }}
                      >
                        {isSubOffline ? 'Offline PDF' : 'Online'}
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.85rem', color: '#6b6252' }}>
                      {sEmail} | Result Status:{' '}
                      <strong style={{ color: isPublished ? '#155724' : '#856404' }}>
                        {getResultStatusLabel(rStatus)}
                      </strong>
                      {isPublished && (sub.totalMarks ?? sub.TotalMarks) != null && (
                        <span> | Score: <strong>{sub.totalMarks ?? sub.TotalMarks}</strong> ({sub.grade ?? sub.Grade})</span>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenGradingWorkspace(pId)}
                    className="manage-btn manage-btn--success"
                    style={{ padding: '8px 16px', fontSize: '0.9rem', whiteSpace: 'nowrap' }}
                  >
                    {isOpeningThis
                      ? 'Opening...'
                      : isPublished
                        ? 'Review / Re-publish'
                        : 'Evaluate & Publish'}{' '}
                    {!isOpeningThis && <>&rarr;</>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Active Grading Workspace Modal */}
      {activeParticipantId !== null && gradingPaper && (
        <div className="modal-overlay grading-modal-overlay">
          <div
            className={`modal-content grading-workspace-modal ${isOfflineSubmission ? 'grading-workspace-modal--split' : ''}`}
          >
            {/* Top Workspace Header */}
            <div className="grading-workspace-topbar">
              <div className="grading-workspace-title-group">
                <span className="grading-workspace-badge">
                  <span className="grading-live-dot" />
                  Grading Workspace
                </span>
                <span className="grading-workspace-breadcrumb">
                  <strong>{headerExamName}</strong>
                  {headerQuestionSet ? ` • Set: ${headerQuestionSet}` : ''}
                  {' • '}Submission #{activeParticipantId} —{' '}
                  <strong>{gradingPaper.studentName ?? gradingPaper.StudentName}</strong>
                </span>
              </div>

              <div className="grading-workspace-topbar-right">
                {lastDraftSavedAt && (
                  <span className="grading-draft-timestamp">Draft Saved {lastDraftSavedAt}</span>
                )}
                <button
                  type="button"
                  onClick={() => setActiveParticipantId(null)}
                  className="modal-close-btn"
                  title="Close Workspace"
                >
                  &times;
                </button>
              </div>
            </div>

            {/* Split-Pane Layout for Offline PDF vs Standard Single-Pane for Online */}
            <div className={`grading-workspace-body ${isOfflineSubmission ? 'is-split' : ''}`}>
              {/* LEFT PANE: Uploaded Student Answer Sheet (PDF) */}
              {isOfflineSubmission && (
                <section className="grading-pdf-pane">
                  <div className="grading-pdf-toolbar">
                    <div className="grading-pdf-file-meta">
                      <span className="grading-pdf-file-badge">PDF</span>
                      <div className="grading-pdf-title-wrap">
                        <h4>Uploaded Student Answer Sheet</h4>
                        <span className="grading-pdf-filename" title={pdfFileName}>
                          {pdfFileName}
                        </span>
                      </div>
                    </div>

                    {resolvedPdfUrl && (
                      <div className="grading-pdf-controls">
                        <a
                          href={resolvedPdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="grading-pdf-tool-btn"
                          title="Open PDF in New Tab"
                        >
                          Open PDF ↗
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="grading-pdf-viewer-frame">
                    {resolvedPdfUrl ? (
                      <iframe
                        key={`${activeParticipantId}-${resolvedPdfUrl}`}
                        src={iframeSrc}
                        title={`Answer Sheet - ${gradingPaper.studentName ?? gradingPaper.StudentName}`}
                        className="grading-pdf-iframe"
                      />
                    ) : (
                      <div className="grading-pdf-empty">
                        <p>No PDF answer sheet URL was found for this offline submission.</p>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* RIGHT PANE: Grading & Feedback Rubric */}
              <section className="grading-rubric-pane">
                <div className="grading-rubric-header">
                  <div>
                    <h3>Question Paper &amp; Grading Rubric</h3>
                    <p className="grading-rubric-subtitle">
                      {isOfflineSubmission
                        ? 'Assign marks and feedback per question while reviewing the PDF answer sheet on the left.'
                        : 'Review candidate responses and assign marks per question.'}
                    </p>
                  </div>
                  <div className="grading-total-score-pill">
                    <span>Total Score:</span>
                    <strong>
                      {totalAwardedScore} / {totalQuestionMaxScore}
                    </strong>
                  </div>
                </div>

                <div className="grading-questions-scroll">
                  {questionsList.length === 0 ? (
                    <div className="grading-rubric-card">
                      <div className="grading-rubric-card-top">
                        <strong>Offline Answer Sheet Evaluation</strong>
                        <span className="grading-weight-badge">Max Marks: {examMaxCap}</span>
                      </div>
                      <p className="grading-question-desc">
                        No digital question items are attached to this exam yet. Assign the overall marks and feedback below, then click <strong>Submit &amp; Grade</strong> to calculate and publish the result.
                      </p>

                      <div className="grading-score-control-row">
                        <div className="grading-slider-group">
                          <div className="grading-slider-label-row">
                            <span>Awarded Score</span>
                            <strong>
                              {offlineOverallScore} / {examMaxCap}
                            </strong>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={examMaxCap}
                            step={0.5}
                            value={offlineOverallScore}
                            onChange={e => handleOfflineScoreChange(e.target.value)}
                            className="grading-score-slider"
                          />
                        </div>

                        <div className="grading-numeric-input-box">
                          <label>Marks</label>
                          <input
                            type="number"
                            max={examMaxCap}
                            min={0}
                            step={0.5}
                            value={offlineOverallScore}
                            onChange={e => handleOfflineScoreChange(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="grading-feedback-field">
                        <label>Faculty Feedback &amp; Notes</label>
                        <textarea
                          rows={4}
                          placeholder="Write evaluation comments, strengths, or areas for improvement..."
                          value={offlineFeedback}
                          onChange={e => setOfflineFeedback(e.target.value)}
                          className="grading-feedback-textarea"
                        />
                      </div>
                    </div>
                  ) : (
                    questionsList.map((q: any, idx: number) => {
                      const stateKey = Number(q?._stateKey ?? -(idx + 1));
                      const maxMarks = Number(q?._maxMarks ?? q?.maxMarks ?? q?.MaxMarks ?? 5);
                      const currentMarks = marksMap[stateKey]?.marks ?? 0;
                      const qTitle = q?._title ?? getQuestionTitleText(q, idx);
                      const qDesc = q?._description ?? getQuestionDescText(q);
                      const studentAns =
                        q.answerDescription ??
                        q.selectedOptionTitle ??
                        q.description ??
                        q.studentAnswer ??
                        q.StudentAnswer ??
                        'No digital answer text (Offline PDF submission).';

                      return (
                        <div key={stateKey} className="grading-rubric-card">
                          <div className="grading-rubric-card-top">
                            <strong>
                              Question {idx + 1}: {qTitle}
                            </strong>
                            <span className="grading-weight-badge">Weight: {maxMarks}</span>
                          </div>

                          {qDesc && (
                            <p className="grading-question-desc">{qDesc}</p>
                          )}

                          {!isOfflineSubmission && (
                            <p className="grading-student-answer-box">
                              <strong>Student Answer:</strong> {studentAns}
                            </p>
                          )}

                          {/* Score Slider + Numeric Input */}
                          <div className="grading-score-control-row">
                            <div className="grading-slider-group">
                              <div className="grading-slider-label-row">
                                <span>Score</span>
                                <strong>
                                  {currentMarks} / {maxMarks}
                                </strong>
                              </div>
                              <input
                                type="range"
                                min={0}
                                max={maxMarks}
                                step={0.5}
                                value={currentMarks}
                                onChange={e => handleMarkChange(stateKey, 'marks', e.target.value, maxMarks)}
                                className="grading-score-slider"
                              />
                            </div>

                            <div className="grading-numeric-input-box">
                              <label>Marks</label>
                              <input
                                type="number"
                                max={maxMarks}
                                min={0}
                                step={0.5}
                                value={currentMarks}
                                onChange={e => handleMarkChange(stateKey, 'marks', e.target.value, maxMarks)}
                              />
                            </div>
                          </div>

                          {/* Faculty Feedback / Criterion Notes */}
                          <div className="grading-feedback-field">
                            <label>Faculty Feedback &amp; Notes</label>
                            <input
                              type="text"
                              placeholder="Provide feedback, criterion met, or reason of marking..."
                              value={marksMap[stateKey]?.reason ?? ''}
                              onChange={e => handleMarkChange(stateKey, 'reason', e.target.value)}
                            />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Sticky Footer Actions */}
                <div className="grading-workspace-footer">
                  <div className="grading-footer-nav">
                    <button
                      type="button"
                      onClick={() => handleNavigateSubmission(-1)}
                      disabled={activeSubmissionIndex <= 0 || isBusy}
                      className="manage-btn manage-btn--secondary grading-nowrap-btn"
                      aria-label="Previous submission"
                      title="Previous submission"
                    >
                      &larr;
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNavigateSubmission(1)}
                      disabled={activeSubmissionIndex === -1 || activeSubmissionIndex >= submissions.length - 1 || isBusy}
                      className="manage-btn manage-btn--secondary grading-nowrap-btn"
                      aria-label="Next submission"
                      title="Next submission"
                    >
                      &rarr;
                    </button>
                  </div>

                  <div className="grading-footer-submit">
                    <button
                      type="button"
                      onClick={() => handleEvaluateWithAi(activeParticipantId)}
                      disabled={isBusy}
                      className="manage-btn manage-btn--secondary grading-nowrap-btn"
                    >
                      {aiEvaluating ? 'AI Evaluating...' : 'AI Evaluate'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveEvaluation(activeParticipantId)}
                      disabled={isBusy}
                      className="manage-btn manage-btn--secondary grading-nowrap-btn"
                    >
                      {savingAction ? 'Saving...' : 'Save Draft'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFinalizeAndPublish(activeParticipantId)}
                      disabled={isBusy}
                      className="manage-btn manage-btn--primary grading-nowrap-btn"
                    >
                      {savingAction ? 'Publishing...' : 'Submit & Grade'}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Grading;