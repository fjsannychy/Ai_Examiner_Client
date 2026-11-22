import axios from '../interceptor'; // Uses your configured Axios instance with JWT headers

const AI_FUNCTION_BASE =
  import.meta.env.VITE_AI_FUNCTION_URL || 'http://localhost:7165/api';

const AI_REQUEST_TIMEOUT_MS = 90000;

export interface AiGenerationResponse {
  success: boolean;
  result: string[];
}

const getAuthHeader = (): Record<string, string> => {
  const interceptorAuth = axios.defaults.headers.common['Authorization'];
  if (typeof interceptorAuth === 'string' && interceptorAuth.trim()) {
    return { Authorization: interceptorAuth };
  }

  const token =
    localStorage.getItem('token') ||
    localStorage.getItem('jwt') ||
    localStorage.getItem('accessToken') ||
    '';

  return token ? { Authorization: `Bearer ${token.replace(/^Bearer\s+/i, '')}` } : {};
};

export const generateExamQuestions = async (prompt: string): Promise<AiGenerationResponse> => {
  try {
    // Passing the prompt via query parameter 'q' matching your C# function setup
    const response = await axios.post<AiGenerationResponse>(
      `${AI_FUNCTION_BASE}/generate-questions?q=${encodeURIComponent(prompt)}`,
      null,
      {
        headers: getAuthHeader(),
        timeout: AI_REQUEST_TIMEOUT_MS,
      }
    );
    return response.data;
  } catch (error: any) {
    throw new Error(
      typeof error?.response?.data === 'string'
        ? error.response.data
        : error?.response?.data?.message || error?.message || 'Failed to generate AI questions.'
    );
  }
};

export const evaluateSubmissionWithAi = async (
  participantId: number,
  isOfflinePdf = false
): Promise<AiGenerationResponse> => {
  const prompt = isOfflinePdf
    ? `Fetch student submission with participantId ${participantId}, inspect the offline PDF answer sheet if available, evaluate each question fairly up to its maxMarks, provide clear reasons, and save the AI evaluation results.`
    : `Fetch student submission with participantId ${participantId}, review the student's answers for each question up to its maxMarks, provide clear marking reasons, and save the AI evaluation results.`;

  return generateExamQuestions(prompt);
};