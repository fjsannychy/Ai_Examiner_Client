// src/Services/gradingServices.ts
import axios from '../interceptor';
import { SaveEvaluationRequest, SubmissionReviewResponse } from '../Models/GradingModel';

export const GradingServices = {
  // 1. Get all pending submissions for an exam
  getPendingSubmissions: async (examId: number, signal?: AbortSignal) => {
    const response = await axios.get<any[]>(`/Grading/pending/exam/${examId}`, { signal });
    return response.data;
  },

  // 2. Get single student submission for review & grading
  getSubmissionForGrading: async (participantId: number, signal?: AbortSignal) => {
    const response = await axios.get<SubmissionReviewResponse>(
      `/Grading/submission/${participantId}`,
      { signal }
    );
    return response.data;
  },

  // 3. Save evaluation scores (per-question)
  saveEvaluation: async (payload: SaveEvaluationRequest, signal?: AbortSignal) => {
    const response = await axios.post('/Grading/save-evaluation', payload, { signal });
    return response.data;
  },

  // 4. Finalize and publish exam result
  finalizeAndPublishResult: async (participantId: number, signal?: AbortSignal) => {
    const response = await axios.post(`/Grading/finalize/${participantId}`, undefined, { signal });
    return response.data;
  }
};