import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readId, readInteger } from "../lib/controller.js";
import { readCursor } from "../lib/cursor.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { readImageInput } from "./image.controller.js";
import {
  addComment as addPostComment,
  createPost,
  deleteComment,
  deletePost,
  getPost,
  listComments as listPostComments,
  listPosts,
  MAX_POST_IMAGES,
  requestPostUpload,
  setPostLike,
  type PageRequest,
  type PostInput,
} from "../services/post.service.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// `cursor` is the nextCursor of the previous page; leave it out for the first page.
const readPage = (query: Record<string, unknown>): PageRequest => ({
  cursor: readCursor(query["cursor"]),
  limit: readInteger(query["limit"], "Limit", 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
});

// Text is optional on a post with photos, so absent or null reads as empty.
const readText = (value: unknown, label: string): string => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new AppError(`${label} must be a string`, 400);
  return value;
};

// Photos posted with the text, each as Cloudinary described it after the upload. Absent means none.
const readImages = (value: unknown) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_POST_IMAGES) {
    throw new AppError(`Images must be a list of at most ${MAX_POST_IMAGES} photos`, 400);
  }
  return value.map((image) => readImageInput(image));
};

const readPostInput = (body: unknown): PostInput => {
  const source = (body ?? {}) as Record<string, unknown>;
  return { text: readText(source["text"], "Post text"), images: readImages(source["images"]) };
};

const readPostId = (req: AuthenticatedRequest) => readId(req.params["postId"], "Post ID");
const readCommentId = (req: AuthenticatedRequest) => readId(req.params["commentId"], "Comment ID");

const handle = handleHouseholdRequest("Post operation failed");

// Signs one photo upload for a post. The app uploads each file to Cloudinary itself, then creates
// the post with the photos' details.
export const authorizeUpload = handle(async (_req, res, householdId, requesterId) => {
  const upload = await requestPostUpload(householdId, requesterId);
  return res.status(201).json({ message: "Upload authorized", upload });
});

export const list = handle(async (req, res, householdId, requesterId) => {
  const { posts, nextCursor } = await listPosts(householdId, requesterId, readPage(req.query));
  return res.status(200).json({ message: "Posts fetched successfully", posts, nextCursor });
});

export const create = handle(async (req, res, householdId, requesterId) => {
  const post = await createPost(householdId, requesterId, readPostInput(req.body));
  return res.status(201).json({ message: "Post created successfully", post });
});

export const get = handle(async (req, res, householdId, requesterId) => {
  const post = await getPost(householdId, requesterId, readPostId(req));
  return res.status(200).json({ message: "Post fetched successfully", post });
});

export const remove = handle(async (req, res, householdId, requesterId) => {
  await deletePost(householdId, requesterId, readPostId(req));
  return res.status(200).json({ message: "Post deleted successfully" });
});

export const like = handle(async (req, res, householdId, requesterId) => {
  const post = await setPostLike(householdId, requesterId, readPostId(req), true);
  return res.status(200).json({ message: "Post liked", post });
});

export const unlike = handle(async (req, res, householdId, requesterId) => {
  const post = await setPostLike(householdId, requesterId, readPostId(req), false);
  return res.status(200).json({ message: "Like removed", post });
});

export const listComments = handle(async (req, res, householdId, requesterId) => {
  const { comments, nextCursor } = await listPostComments(householdId, requesterId, readPostId(req), readPage(req.query));
  return res.status(200).json({ message: "Comments fetched successfully", comments, nextCursor });
});

export const addComment = handle(async (req, res, householdId, requesterId) => {
  const text = (req.body as Record<string, unknown> | undefined)?.["text"];
  if (typeof text !== "string") throw new AppError("Comment text is required", 400);
  const comment = await addPostComment(householdId, requesterId, readPostId(req), text);
  return res.status(201).json({ message: "Comment added successfully", comment });
});

export const removeComment = handle(async (req, res, householdId, requesterId) => {
  await deleteComment(householdId, requesterId, readPostId(req), readCommentId(req));
  return res.status(200).json({ message: "Comment deleted successfully" });
});
