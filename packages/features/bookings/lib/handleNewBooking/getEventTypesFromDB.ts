import type { LocationObject } from "@calcom/app-store/locations";
import { workflowSelect } from "@calcom/ee/workflows/lib/getAllWorkflows";
import { getBookingFieldsWithSystemFields } from "@calcom/features/bookings/lib/getBookingFields";
import type { DefaultEvent } from "@calcom/lib/defaultEvents";
import { parseRecurringEvent } from "@calcom/lib/isRecurringEvent";
import { withSelectedCalendars } from "@calcom/lib/server/repository/user";
import prisma, { userSelect } from "@calcom/prisma";
import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";
import {
  EventTypeMetaDataSchema,
  customInputSchema,
  rrSegmentQueryValueSchema,
} from "@calcom/prisma/zod-utils";

export const getEventTypesFromDB = async (eventTypeId: number) => {
  const eventType = await prisma.eventType.findUniqueOrThrow({
    where: {
      id: eventTypeId,
    },
    select: {
      id: true,
      customInputs: true,
      disableGuests: true,
      restrictionScheduleId: true,
      useBookerTimezone: true,
      users: {
        select: {
          credentials: {
            select: credentialForCalendarServiceSelect,
          },
          ...userSelect.select,
        },
      },
      slug: true,
      profile: {
        select: {
          organizationId: true,
        },
      },
      teamId: true,
      team: {
        select: {
          id: true,
          name: true,
          parentId: true,
          bookingLimits: true,
          includeManagedEventsInLimits: true,
          rrResetInterval: true,
          rrTimestampBasis: true,
        },
      },
      bookingFields: true,
      title: true,
      length: true,
      eventName: true,
      schedulingType: true,
      description: true,
      periodType: true,
      periodStartDate: true,
      periodEndDate: true,
      periodDays: true,
      periodCountCalendarDays: true,
      lockTimeZoneToggleOnBookingPage: true,
      requiresConfirmation: true,
      requiresConfirmationForFreeEmail: true,
      requiresBookerEmailVerification: true,
      maxLeadThreshold: true,
      includeNoShowInRRCalculation: true,
      minimumBookingNotice: true,
      maxActiveBookingsPerBooker: true,
      maxActiveBookingPerBookerOfferReschedule: true,
      userId: true,
      price: true,
      currency: true,
      metadata: true,
      destinationCalendar: true,
      hideCalendarNotes: true,
      hideCalendarEventDetails: true,
      hideOrganizerEmail: true,
      seatsPerTimeSlot: true,
      recurringEvent: true,
      seatsShowAttendees: true,
      seatsShowAvailabilityCount: true,
      bookingLimits: true,
      durationLimits: true,
      rescheduleWithSameRoundRobinHost: true,
      assignAllTeamMembers: true,
      isRRWeightsEnabled: true,
      beforeEventBuffer: true,
      customReplyToEmail: true,
      afterEventBuffer: true,
      parentId: true,
      parent: {
        select: {
          teamId: true,
          team: {
            select: {
              id: true,
              bookingLimits: true,
              includeManagedEventsInLimits: true,
            },
          },
        },
      },
      useEventTypeDestinationCalendarEmail: true,
      owner: {
        select: {
          hideBranding: true,
        },
      },
      workflows: {
        select: {
          workflow: {
            select: workflowSelect,
          },
        },
      },
      locations: true,
      timeZone: true,
      schedule: {
        select: {
          id: true,
          availability: true,
          timeZone: true,
        },
      },
      hosts: {
        select: {
          isFixed: true,
          priority: true,
          weight: true,
          createdAt: true,
          user: {
            select: {
              credentials: {
                select: credentialForCalendarServiceSelect,
              },
              ...userSelect.select,
            },
          },
          schedule: {
            select: {
              availability: {
                select: {
                  date: true,
                  startTime: true,
                  endTime: true,
                  days: true,
                },
              },
              timeZone: true,
              id: true,
            },
          },
        },
      },
      availability: {
        select: {
          date: true,
          startTime: true,
          endTime: true,
          days: true,
        },
      },
      secondaryEmailId: true,
      secondaryEmail: {
        select: {
          id: true,
          email: true,
        },
      },
      assignRRMembersUsingSegment: true,
      rrSegmentQueryValue: true,
      useEventLevelSelectedCalendars: true,
    },
  });

  const { profile, hosts, users, ...restEventType } = eventType;
  const isOrgTeamEvent = !!eventType?.team && !!profile?.organizationId;

  const hostsWithSelectedCalendars = hosts.map((host) => ({
    ...host,
    user: withSelectedCalendars(host.user),
  }));

  const usersWithSelectedCalendars = users.map((user) => withSelectedCalendars(user));

  return {
    ...restEventType,
    hosts: hostsWithSelectedCalendars,
    users: usersWithSelectedCalendars,
    metadata: EventTypeMetaDataSchema.parse(eventType?.metadata || {}),
    recurringEvent: parseRecurringEvent(eventType?.recurringEvent),
    customInputs: customInputSchema.array().parse(eventType?.customInputs || []),
    locations: (eventType?.locations ?? []) as LocationObject[],
    bookingFields: getBookingFieldsWithSystemFields({ ...restEventType, isOrgTeamEvent }),
    rrSegmentQueryValue: rrSegmentQueryValueSchema.parse(eventType.rrSegmentQueryValue) ?? null,
    isDynamic: false,
  };
};

export type getEventTypeResponse = Awaited<ReturnType<typeof getEventTypesFromDB>>;

export type NewBookingEventType = DefaultEvent | getEventTypeResponse;
