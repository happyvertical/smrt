import type {
  ApiResponse,
  ContentGovernanceAssignmentData,
  ContentGovernanceDefinitionsData,
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
} from '../mock-smrt-client';

export interface ContentGovernanceManagerClient {
  contents: {
    getGovernanceDefinitions: () => Promise<
      ApiResponse<ContentGovernanceDefinitionsData>
    >;
  };
  contentGovernancePolicies: {
    create: (
      data: Partial<ContentReviewPolicyData>,
    ) => Promise<ApiResponse<ContentReviewPolicyData>>;
    update: (
      id: string,
      data: Partial<ContentReviewPolicyData>,
    ) => Promise<ApiResponse<ContentReviewPolicyData>>;
    delete: (id: string) => Promise<ApiResponse<void>>;
  };
  contentGovernanceProfiles: {
    create: (
      data: Partial<ContentGovernanceProfileData>,
    ) => Promise<ApiResponse<ContentGovernanceProfileData>>;
    update: (
      id: string,
      data: Partial<ContentGovernanceProfileData>,
    ) => Promise<ApiResponse<ContentGovernanceProfileData>>;
    delete: (id: string) => Promise<ApiResponse<void>>;
  };
  contentGovernanceAssignments: {
    create: (
      data: Partial<ContentGovernanceAssignmentData>,
    ) => Promise<ApiResponse<ContentGovernanceAssignmentData>>;
    update: (
      id: string,
      data: Partial<ContentGovernanceAssignmentData>,
    ) => Promise<ApiResponse<ContentGovernanceAssignmentData>>;
    delete: (id: string) => Promise<ApiResponse<void>>;
  };
}
