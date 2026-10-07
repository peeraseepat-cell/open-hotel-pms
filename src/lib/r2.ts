import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export function getR2Bucket(): string {
  return String(process.env.R2_BUCKET_NAME ?? "pms-backups").trim() || "pms-backups";
}

export function getR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: requireEnv("R2_ENDPOINT"),
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
}

export async function uploadR2Object(params: {
  key: string;
  body: Buffer | Uint8Array | ArrayBuffer;
  contentType: string;
  contentEncoding?: string;
}) {
  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2Bucket(),
    Key: params.key,
    Body: params.body instanceof ArrayBuffer ? Buffer.from(params.body) : params.body,
    ContentType: params.contentType,
    ContentEncoding: params.contentEncoding,
  }));
  return { key: params.key };
}

export async function readR2Object(key: string) {
  const response = await getR2Client().send(new GetObjectCommand({
    Bucket: getR2Bucket(),
    Key: key,
  }));
  const body = await response.Body?.transformToByteArray();
  if (!body) throw new Error("Object not found.");
  return {
    body: Buffer.from(body),
    contentType: response.ContentType ?? "application/octet-stream",
  };
}

export async function deleteR2Objects(keys: string[]) {
  const uniqueKeys = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
  if (uniqueKeys.length === 0) return { deleted: 0 };

  for (let index = 0; index < uniqueKeys.length; index += 1000) {
    const chunk = uniqueKeys.slice(index, index + 1000);
    const response = await getR2Client().send(new DeleteObjectsCommand({
      Bucket: getR2Bucket(),
      Delete: {
        Objects: chunk.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));
    if (response.Errors?.length) {
      throw new Error(`Failed to delete ${response.Errors.length} R2 object(s).`);
    }
  }

  return { deleted: uniqueKeys.length };
}
