import { getAnalytics } from "@/lib/analytics/get-analytics";
import { validDateRangeForPlan } from "@/lib/analytics/utils";
import {
  DubApiError,
  exceededLimitError,
  handleAndReturnErrorResponse,
} from "@/lib/api/errors";
import { PlanProps } from "@/lib/types";
import { ratelimit } from "@/lib/upstash";
import { analyticsQuerySchema } from "@/lib/zod/schemas/analytics";
import { prisma } from "@dub/prisma";
import { DUB_DEMO_LINKS, DUB_WORKSPACE_ID, getSearchParams } from "@dub/utils";
import { ipAddress } from "@vercel/functions";
import { NextResponse } from "next/server";

export const GET = async (req: Request) => {
  try {
    // Parse and validate search parameters
    const searchParams = getSearchParams(req.url);
    const parsedParams = analyticsQuerySchema.parse(searchParams);
    const { groupBy, domain, key, interval, start, end } = parsedParams;

    if (!domain || !key) {
      throw new DubApiError({
        code: "bad_request",
        message: "Missing domain or key query parameter",
      });
    }

    let link;
    const demoLink = DUB_DEMO_LINKS.find((l) => l.domain === domain && l.key === key);

    if (demoLink) {
      // Handle demo links
      link = {
        id: demoLink.id,
        projectId: DUB_WORKSPACE_ID,
      };
    } else {
      // Fetch the link from the database
      link = await prisma.link.findUnique({
        where: { domain_key: { domain, key } },
        select: {
          id: true,
          dashboard: true,
          projectId: true,
          project: {
            select: {
              plan: true,
              usage: true,
              usageLimit: true,
              conversionEnabled: true,
            },
          },
        },
      });

      if (!link?.dashboard) {
        throw new DubApiError({
          code: "forbidden",
          message: "This link does not have a public analytics dashboard",
        });
      }

      // Validate date range for the plan
      validDateRangeForPlan({
        plan: link.project?.plan || "free",
        conversionEnabled: link.project?.conversionEnabled,
        interval,
        start,
        end,
        throwError: true,
      });

      // Check usage limits
      if (link.project && link.project.usage > link.project.usageLimit) {
        throw new DubApiError({
          code: "forbidden",
          message: exceededLimitError({
            plan: link.project.plan as PlanProps,
            limit: link.project.usageLimit,
            type: "clicks",
          }),
        });
      }
    }

    // Implement rate limiting in production
    if (process.env.NODE_ENV !== "development") {
      const ip = ipAddress(req);
      const rateLimitDuration = demoLink ? (groupBy === "count" ? "10 s" : "1 m") : "10 s";
      const rateLimitCount = demoLink ? 15 : 10;
      
      const { success } = await ratelimit(rateLimitCount, rateLimitDuration)
        .limit(`analytics-dashboard:${link.id}:${ip}:${groupBy}`);

      if (!success) {
        throw new DubApiError({
          code: "rate_limit_exceeded",
          message: "Don't DDoS me pls 🥺",
        });
      }
    }

    // Fetch analytics data
    const response = await getAnalytics({
      ...parsedParams,
      ...(link.projectId && { workspaceId: link.projectId }),
      linkId: link.id,
    });

    return NextResponse.json(response);
  } catch (error) {
    return handleAndReturnErrorResponse(error);
  }
};