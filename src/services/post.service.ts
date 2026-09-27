import type { HouseholdRole, Prisma } from "../../generated/prisma/client.js";
import { createUploadTicket, imageStorage, isImageIn, postFolder } from "../lib/cloudinary.js";
import { newerThan, olderThan, pageOf, type Cursor } from "../lib/cursor.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import { userSummary } from "../lib/user-select.js";
import { requireHouseholdMember } from "./household-access.service.js";
import { imagePublicIds, imagesSelect, MAX_IMAGES, toImageView, type ImageInput } from "./image.service.js";
import { actorName, createNotification, type NotificationType } from "./notification.service.js";

export const MAX_POST_TEXT = 4000;
export const MAX_COMMENT_TEXT = 1000;
export const MAX_POST_IMAGES = MAX_IMAGES;
// How much of a post an inbox entry quotes.
const PREVIEW_LENGTH = 100;
// Every notification whose entityId is a post.
const POST_NOTIFICATION_TYPES = ["POST_CREATED", "POST_COMMENTED"] as const satisfies readonly NotificationType[];

// A post is text, photos, or both. The photos were uploaded beforehand with tickets from
// requestPostUpload; `images` is what Cloudinary reported for them, in the order they were picked.
export type PostInput = { text: string; images: ImageInput[] };

// Where a page starts, and how many rows it holds. No cursor means the first page.
export type PageRequest = { cursor?: Cursor | undefined; limit: number };

// The post as the API returns it. `likes` is narrowed to the requester's own like, so a post can say
// whether they liked it without loading every like.
const postSelect = (requesterId: string) => ({
  id: true,
  householdId: true,
  text: true,
  createdAt: true,
  author: userSummary,
  images: imagesSelect,
  likes: { where: { userId: requesterId }, select: { userId: true } },
  _count: { select: { likes: true, comments: true } },
} satisfies Prisma.PostSelect);

type PostRow = Prisma.PostGetPayload<{ select: ReturnType<typeof postSelect> }>;

const commentSelect = {
  id: true,
  postId: true,
  text: true,
  createdAt: true,
  author: userSummary,
} satisfies Prisma.PostCommentSelect;

// The feed is newest first and comments oldest first. The ID breaks ties in both, matching the cursor.
const feedOrder = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.PostOrderByWithRelationInput[];
const commentOrder = [{ createdAt: "asc" }, { id: "asc" }] satisfies Prisma.PostCommentOrderByWithRelationInput[];

const postMessages: TransactionMessages = {
  conflict: "Post conflicts with an existing post",
  missing: "Household, member, post, or comment no longer exists",
  retriesExhausted: "Posts changed concurrently; please retry",
};

const withPostTransaction = <Result>(
  operation: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> => withSerializableTransaction(operation, postMessages);

// Photos carry their delivery URLs instead of their public IDs, and the counts are flattened.
const toPostView = ({ images, likes, _count, ...post }: PostRow) => ({
  ...post,
  images: images.map(toImageView),
  likeCount: _count.likes,
  commentCount: _count.comments,
  likedByMe: likes.length > 0,
});

// Authorizes one photo upload straight to Cloudinary, into the household's posts folder.
export function requestPostUpload(householdId: string, requesterId: string) {
  return withPostTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    return createUploadTicket(postFolder(householdId));
  });
}

// The household's posts, newest first. nextCursor fetches the next, older page.
export function listPosts(householdId: string, requesterId: string, page: PageRequest) {
  return withPostTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    const rows = await tx.post.findMany({
      where: { householdId, ...(page.cursor && olderThan(page.cursor)) },
      select: postSelect(requesterId),
      orderBy: feedOrder,
      take: page.limit + 1,
    });
    const { items, nextCursor } = pageOf(rows, page.limit, toPostView);
    return { posts: items, nextCursor };
  });
}

export function getPost(householdId: string, requesterId: string, postId: string) {
  return withPostTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    return loadPost(tx, householdId, requesterId, postId);
  });
}

// Every other member hears about a new post.
export function createPost(householdId: string, requesterId: string, input: PostInput) {
  const text = input.text.trim();
  if (text.length > MAX_POST_TEXT) throw new AppError(`Post text must be at most ${MAX_POST_TEXT} characters`, 400);
  if (!text && !input.images.length) throw new AppError("Post must contain text or a photo", 400);
  if (input.images.length > MAX_POST_IMAGES) throw new AppError(`A post can carry at most ${MAX_POST_IMAGES} photos`, 400);
  const publicIds = input.images.map((image) => image.publicId);
  if (new Set(publicIds).size !== publicIds.length) throw new AppError("The same photo was added twice", 400);

  return withPostTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    const folder = postFolder(householdId);
    if (publicIds.some((publicId) => !isImageIn(folder, publicId))) {
      throw new AppError("Photo was not uploaded for this household's posts", 400);
    }
    if (publicIds.length && await tx.image.count({ where: { publicId: { in: publicIds } } })) {
      throw new AppError("This photo was already posted", 409);
    }

    // Rows written in one transaction share the database's clock, and photos are shown in createdAt
    // order. Stamping each a millisecond after the one before keeps the order they were picked in.
    const start = Date.now();
    const post = await tx.post.create({
      data: {
        householdId,
        authorId: requesterId,
        text,
        images: {
          create: input.images.map((image, index) => ({
            ...image, householdId, uploadedById: requesterId, createdAt: new Date(start + index),
          })),
        },
      },
      select: postSelect(requesterId),
    });
    await notifyNewPost(tx, householdId, requesterId, post);
    return toPostView(post);
  });
}

// The author can delete their post, and owners and admins can delete anyone's. Likes, comments and
// photo rows go with it; the photo files leave Cloudinary after the commit. Its notifications go
// too: they quote the post, and a post removed by an admin must not live on in everyone's inbox.
export async function deletePost(householdId: string, requesterId: string, postId: string) {
  const publicIds = await withPostTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const post = await requirePost(tx, householdId, postId);
    requireAuthorOrModerator(requester.role, requesterId, post.authorId, "You can only delete your own posts");

    // Collected before the delete cascades the image rows away.
    const publicIds = await imagePublicIds(tx, { postId: post.id });
    await tx.notification.deleteMany({ where: { householdId, entityId: post.id, type: { in: [...POST_NOTIFICATION_TYPES] } } });
    await tx.post.delete({ where: { id: post.id } });
    return publicIds;
  });
  if (publicIds.length > 0) void imageStorage.destroy(publicIds);
}

// Liking a post already liked, or unliking one never liked, changes nothing and still succeeds, so an
// app can retry either after a lost response. The post comes back with its new count.
export function setPostLike(householdId: string, requesterId: string, postId: string, liked: boolean) {
  return withPostTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    const post = await requirePost(tx, householdId, postId);
    if (liked) {
      await tx.postLike.createMany({ data: [{ postId: post.id, userId: requesterId }], skipDuplicates: true });
    } else {
      await tx.postLike.deleteMany({ where: { postId: post.id, userId: requesterId } });
    }
    return loadPost(tx, householdId, requesterId, post.id);
  });
}

// A post's comments, oldest first. nextCursor fetches the next, newer page.
export function listComments(householdId: string, requesterId: string, postId: string, page: PageRequest) {
  return withPostTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    const post = await requirePost(tx, householdId, postId);
    const rows = await tx.postComment.findMany({
      where: { postId: post.id, ...(page.cursor && newerThan(page.cursor)) },
      select: commentSelect,
      orderBy: commentOrder,
      take: page.limit + 1,
    });
    const { items, nextCursor } = pageOf(rows, page.limit, (comment) => comment);
    return { comments: items, nextCursor };
  });
}

// The post's author hears about a comment, unless they wrote it or have left the household. The
// notification does not quote the comment, so a deleted comment leaves nothing behind in the inbox.
export function addComment(householdId: string, requesterId: string, postId: string, rawText: string) {
  const text = rawText.trim();
  if (!text) throw new AppError("Comment text is required", 400);
  if (text.length > MAX_COMMENT_TEXT) throw new AppError(`Comment text must be at most ${MAX_COMMENT_TEXT} characters`, 400);

  return withPostTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    const post = await requirePost(tx, householdId, postId);
    const comment = await tx.postComment.create({
      data: { postId: post.id, authorId: requesterId, text },
      select: commentSelect,
    });

    if (post.authorId !== requesterId && await isMember(tx, householdId, post.authorId)) {
      await createNotification({
        userId: post.authorId,
        type: "POST_COMMENTED",
        title: "New comment on your post",
        message: `${await actorName(tx, requesterId)} commented on your post`,
        householdId,
        entityId: post.id,
      }, tx);
    }
    return comment;
  });
}

// The comment's author can delete it, and owners and admins can delete anyone's.
export function deleteComment(householdId: string, requesterId: string, postId: string, commentId: string) {
  return withPostTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const post = await requirePost(tx, householdId, postId);
    const comment = await tx.postComment.findFirst({
      where: { id: commentId, postId: post.id },
      select: { id: true, authorId: true },
    });
    if (!comment) throw new AppError("Comment not found", 404);
    requireAuthorOrModerator(requester.role, requesterId, comment.authorId, "You can only delete your own comments");

    await tx.postComment.delete({ where: { id: comment.id } });
  });
}

// Members manage what they wrote themselves. Owners and admins look after the whole household, so
// they may remove anyone's post or comment.
const requireAuthorOrModerator = (role: HouseholdRole, requesterId: string, authorId: string, refusal: string) => {
  if (role === "MEMBER" && authorId !== requesterId) throw new AppError(refusal, 403);
};

async function requirePost(tx: Prisma.TransactionClient, householdId: string, postId: string) {
  const post = await tx.post.findFirst({ where: { id: postId, householdId }, select: { id: true, authorId: true } });
  if (!post) throw new AppError("Post not found", 404);
  return post;
}

// The post as the API returns it, as the requester sees it.
async function loadPost(tx: Prisma.TransactionClient, householdId: string, requesterId: string, postId: string) {
  const post = await tx.post.findFirst({ where: { id: postId, householdId }, select: postSelect(requesterId) });
  if (!post) throw new AppError("Post not found", 404);
  return toPostView(post);
}

async function isMember(tx: Prisma.TransactionClient, householdId: string, userId: string) {
  const member = await tx.householdMember.findUnique({
    where: { userId_householdId: { userId, householdId } },
    select: { id: true },
  });
  return member !== null;
}

// One inbox entry per current member except the author, in the post's own transaction.
async function notifyNewPost(tx: Prisma.TransactionClient, householdId: string, requesterId: string, post: PostRow) {
  const members = await tx.householdMember.findMany({
    where: { householdId, userId: { not: requesterId } },
    select: { userId: true },
  });
  if (!members.length) return;
  const message = `${await actorName(tx, requesterId)}: ${preview(post.text, post.images.length)}`;
  for (const member of members) {
    await createNotification({
      userId: member.userId,
      type: "POST_CREATED",
      title: "New household post",
      message,
      householdId,
      entityId: post.id,
    }, tx);
  }
}

// One line for an inbox entry: the start of the text, or the photos when there is no text.
// Counted in characters, so an emoji is never cut in half.
function preview(text: string, photoCount: number) {
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  if (characters.length) {
    return characters.length > PREVIEW_LENGTH ? `${characters.slice(0, PREVIEW_LENGTH).join("").trimEnd()}…` : characters.join("");
  }
  return photoCount === 1 ? "📷 Photo" : `📷 ${photoCount} photos`;
}
