import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { usersService } from '../../lib/api';
import { queryKeys } from '../../lib/query/keys';
import { S3_UPLOAD_THRESHOLD, MAX_FILE_SIZE } from '@/lib/constants/upload';
import type {
  UserRead,
  UserCreate,
  UserUpdate,
  UserQueryParams,
} from '../../lib/api/types';

export function useUsers(params?: UserQueryParams) {
  return useQuery({
    queryKey: queryKeys.users.list(params),
    queryFn: () => usersService.getAll(params),
    placeholderData: (previousData) => previousData,
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => usersService.getById(id),
    enabled: !!id,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UserCreate) => usersService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.lists() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.dashboard.stats(),
        refetchType: 'active',
      });
      toast.success('User created successfully');
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Failed to create user';
      toast.error(message);
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UserUpdate }) =>
      usersService.update(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.users.detail(id) });
      const previousUser = queryClient.getQueryData<UserRead>(
        queryKeys.users.detail(id)
      );
      if (previousUser) {
        const optimisticUpdate: UserRead = {
          ...previousUser,
          first_name: data.first_name !== undefined ? data.first_name : previousUser.first_name,
          last_name: data.last_name !== undefined ? data.last_name : previousUser.last_name,
          email: data.email !== undefined ? data.email : previousUser.email,
          external_user_id: data.external_user_id ?? previousUser.external_user_id,
        };
        queryClient.setQueryData<UserRead>(queryKeys.users.detail(id), optimisticUpdate);
      }
      return { previousUser };
    },
    onSuccess: (updatedUser, { id }) => {
      queryClient.setQueryData(queryKeys.users.detail(id), updatedUser);
      queryClient.invalidateQueries({ queryKey: queryKeys.users.lists() });
      toast.success('User updated successfully');
    },
    onError: (error: unknown, { id }, context) => {
      if (context?.previousUser) {
        queryClient.setQueryData(queryKeys.users.detail(id), context.previousUser);
      }
      const message = error instanceof Error ? error.message : 'Failed to update user';
      toast.error(message);
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => usersService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.stats(), refetchType: 'active' });
      toast.success('User deleted successfully');
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to delete user';
      toast.error(message);
    },
  });
}

export function useGenerateInvitationCode() {
  return useMutation({
    mutationFn: (userId: string) => usersService.generateInvitationCode(userId),
    onSuccess: () => { toast.success('Invitation code generated successfully'); },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to generate invitation code';
      toast.error(message);
    },
  });
}

export function useUploadAppleXml() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, file }: { userId: string; file: File }) =>
      usersService.uploadAppleXml(userId, file),
    onSuccess: (_data, { userId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.detail(userId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.health.all, refetchType: 'active' });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to upload XML file';
      toast.error(message);
    },
  });
}

interface UseAppleXmlUploadOptions {
  onSuccess?: (userId: string) => void;
  onError?: (error: Error) => void;
  onUploadProgress?: (percent: number) => void;
  onTaskId?: (taskId: string) => void;
}

export function useAppleXmlUpload(options: UseAppleXmlUploadOptions = {}) {
  const queryClient = useQueryClient();
  const [uploadingUserId, setUploadingUserId] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);

  const { mutate: uploadDirect } = useUploadAppleXml();

  const handleUpload = useCallback(
    (userId: string, event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      event.target.value = '';

      const isValidExtension = file.name.toLowerCase().endsWith('.xml');
      const isValidMimeType = file.type === 'text/xml' || file.type === 'application/xml';
      if (!isValidExtension && !isValidMimeType) {
        toast.error('Invalid file type. Please upload an XML file (.xml)');
        options.onError?.(new Error('Invalid file type'));
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        const maxSizeGB = (MAX_FILE_SIZE / (1024 * 1024 * 1024)).toFixed(0);
        const fileSizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(2);
        toast.error(`File is too large (${fileSizeGB}GB). Maximum size is ${maxSizeGB}GB`);
        options.onError?.(new Error('File size exceeds maximum limit'));
        return;
      }

      setUploadingUserId(userId);
      setUploadPercent(0);

      if (file.size > S3_UPLOAD_THRESHOLD) {
        // S3/MinIO upload with progress
        (async () => {
          try {
            // Step 1: Get presigned URL
            const presignedData = await usersService.getAppleXmlPresignedUrl(userId, {
              filename: file.name,
              max_file_size: file.size,
            });

            // Step 2: Upload with XHR progress
            await new Promise<void>((resolve, reject) => {
              const formData = new FormData();
              Object.entries(presignedData.form_fields).forEach(([key, value]) => {
                formData.append(key, value);
              });
              formData.append('file', file);

              const xhr = new XMLHttpRequest();
              xhr.open('POST', presignedData.upload_url);
              xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                  const pct = Math.round((e.loaded / e.total) * 100);
                  setUploadPercent(pct);
                  options.onUploadProgress?.(pct);
                }
              };
              xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  setUploadPercent(100);
                  options.onUploadProgress?.(100);
                  resolve();
                } else {
                  reject(new Error(`Upload failed: ${xhr.statusText}`));
                }
              };
              xhr.onerror = () => reject(new Error('Upload failed: network error'));
              xhr.send(formData);
            });

            // Step 3: Confirm and get task_id
            const confirmResult = await usersService.confirmS3Upload(
              userId,
              presignedData.file_key,
              presignedData.bucket
            );
            const taskId = (confirmResult as Record<string, string>).task_id;
            if (taskId) {
              options.onTaskId?.(taskId);
            }

            queryClient.invalidateQueries({ queryKey: queryKeys.users.detail(userId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.health.all, refetchType: 'active' });
            options.onSuccess?.(userId);
          } catch (error) {
            setUploadPercent(null);
            setUploadingUserId(null);
            const message = error instanceof Error ? error.message : 'Failed to upload XML file to S3';
            toast.error(message);
            options.onError?.(error as Error);
          }
        })();
      } else {
        uploadDirect(
          { userId, file },
          {
            onSuccess: () => options.onSuccess?.(userId),
            onError: (error) => options.onError?.(error as Error),
            onSettled: () => {
              setUploadingUserId(null);
              setUploadPercent(null);
            },
          }
        );
      }
    },
    [uploadDirect, options, queryClient]
  );

  return {
    handleUpload,
    uploadingUserId,
    uploadPercent,
    isUploading: (userId: string) => uploadingUserId === userId,
  };
}
