import { BookingsRepository_2024_08_13 } from "@/ee/bookings/2024-08-13/bookings.repository";
import { CalendarLink } from "@/ee/bookings/2024-08-13/outputs/calendar-links.output";
import { ErrorsBookingsService_2024_08_13 } from "@/ee/bookings/2024-08-13/services/errors.service";
import { InputBookingsService_2024_08_13 } from "@/ee/bookings/2024-08-13/services/input.service";
import { OutputBookingsService_2024_08_13 } from "@/ee/bookings/2024-08-13/services/output.service";
import { PlatformBookingsService } from "@/ee/bookings/shared/platform-bookings.service";
import { EventTypesRepository_2024_06_14 } from "@/ee/event-types/event-types_2024_06_14/event-types.repository";
import { getPagination } from "@/lib/pagination/pagination";
import { BillingService } from "@/modules/billing/services/billing.service";
import { BookingSeatRepository } from "@/modules/booking-seat/booking-seat.repository";
import { KyselyReadService } from "@/modules/kysely/kysely-read.service";
import { OAuthClientRepository } from "@/modules/oauth-clients/oauth-client.repository";
import { OAuthClientUsersService } from "@/modules/oauth-clients/services/oauth-clients-users.service";
import { OrganizationsRepository } from "@/modules/organizations/index/organizations.repository";
import { OrganizationsTeamsRepository } from "@/modules/organizations/teams/index/organizations-teams.repository";
import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import { TeamsEventTypesRepository } from "@/modules/teams/event-types/teams-event-types.repository";
import { TeamsRepository } from "@/modules/teams/teams/teams.repository";
import { UsersService } from "@/modules/users/services/users.service";
import { UsersRepository, UserWithProfile } from "@/modules/users/users.repository";
import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { Request } from "express";
import { DateTime } from "luxon";
import { z } from "zod";

import {
  handleNewRecurringBooking,
  getTranslation,
  getAllUserBookings,
  handleInstantMeeting,
  handleCancelBooking,
  roundRobinReassignment,
  roundRobinManualReassignment,
  handleMarkNoShow,
  confirmBookingHandler,
  getCalendarLinks,
} from "@calcom/platform-libraries";
import { handleNewBooking } from "@calcom/platform-libraries";
import {
  CreateBookingInput_2024_08_13,
  CreateBookingInput,
  CreateRecurringBookingInput_2024_08_13,
  GetBookingsInput_2024_08_13,
  CreateInstantBookingInput_2024_08_13,
  MarkAbsentBookingInput_2024_08_13,
  ReassignToUserBookingInput_2024_08_13,
  BookingOutput_2024_08_13,
  RecurringBookingOutput_2024_08_13,
  GetSeatedBookingOutput_2024_08_13,
  GetRecurringSeatedBookingOutput_2024_08_13,
  RescheduleBookingInput,
  CancelBookingInput,
} from "@calcom/platform-types";
import { PrismaClient } from "@calcom/prisma";
import { EventType, User, Team } from "@calcom/prisma/client";

type CreatedBooking = {
  hosts: { id: number }[];
  uid: string;
  start: string;
};

const eventTypeBookingFieldSchema = z
  .object({
    name: z.string(),
    required: z.boolean(),
    editable: z.string(),
    type: z.string(),
    options: z.array(z.object({ value: z.string() })).optional(),
  })
  .passthrough();

export const eventTypeBookingFieldsSchema = z.array(eventTypeBookingFieldSchema);

export type EventTypeWithOwnerAndTeam = EventType & { owner: User | null; team: Team | null };

@Injectable()
export class BookingsService_2024_08_13 {
  private readonly logger = new Logger("BookingsService");
  constructor(
    private readonly inputService: InputBookingsService_2024_08_13,
    private readonly outputService: OutputBookingsService_2024_08_13,
    private readonly bookingsRepository: BookingsRepository_2024_08_13,
    private readonly bookingSeatRepository: BookingSeatRepository,
    private readonly eventTypesRepository: EventTypesRepository_2024_06_14,
    private readonly prismaReadService: PrismaReadService,
    private readonly kyselyReadService: KyselyReadService,
    private readonly billingService: BillingService,
    private readonly usersService: UsersService,
    private readonly usersRepository: UsersRepository,
    private readonly platformBookingsService: PlatformBookingsService,
    private readonly oAuthClientRepository: OAuthClientRepository,
    private readonly organizationsTeamsRepository: OrganizationsTeamsRepository,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly teamsRepository: TeamsRepository,
    private readonly teamsEventTypesRepository: TeamsEventTypesRepository,
    private readonly errorsBookingsService: ErrorsBookingsService_2024_08_13
  ) {}

  async createBooking(request: Request, body: CreateBookingInput) {
    let bookingTeamEventType = false;
    try {
      const eventType = await this.getBookedEventType(body);
      if (eventType?.team) {
        bookingTeamEventType = true;
      }
      if (!eventType) {
        this.errorsBookingsService.handleEventTypeToBeBookedNotFound(body);
      }

      if (eventType.schedulingType === "MANAGED") {
        throw new BadRequestException(
          `Event type with id=${eventType.id} is the parent managed event type that can't be booked. You have to provide the child event type id aka id of event type that has been assigned to one of the users.`
        );
      }

      body.eventTypeId = eventType.id;

      if ("instant" in body && body.instant) {
        return await this.createInstantBooking(request, body, eventType);
      }

      const isRecurring = !!eventType?.recurringEvent;
      const isSeated = !!eventType?.seatsPerTimeSlot;

      await this.hasRequiredBookingFieldsResponses(body, eventType);

      if (isRecurring && isSeated) {
        return await this.createRecurringSeatedBooking(request, body, eventType);
      }
      if (isRecurring && !isSeated) {
        return await this.createRecurringBooking(request, body, eventType);
      }
      if (isSeated) {
        return await this.createSeatedBooking(request, body, eventType);
      }

      return await this.createRegularBooking(request, body, eventType);
    } catch (error) {
      this.errorsBookingsService.handleBookingError(error, bookingTeamEventType);
    }
  }

  async getBookedEventType(body: CreateBookingInput) {
    if (body.eventTypeId) {
      return await this.eventTypesRepository.getEventTypeByIdWithOwnerAndTeam(body.eventTypeId);
    } else if (body.username && body.eventTypeSlug) {
      const user = await this.usersRepository.findByUsername(body.username, body.organizationSlug);
      if (!user) {
        throw new NotFoundException(`User with username ${body.username} not found`);
      }
      return await this.eventTypesRepository.getUserEventTypeBySlugWithOwnerAndTeam(
        user.id,
        body.eventTypeSlug
      );
    } else if (body.teamSlug && body.eventTypeSlug) {
      const team = await this.getBookedEventTypeTeam(body.teamSlug, body.organizationSlug);
      if (!team) {
        throw new NotFoundException(`Team with slug ${body.teamSlug} not found`);
      }
      return await this.teamsEventTypesRepository.getEventTypeByTeamIdAndSlugWithOwnerAndTeam(
        team.id,
        body.eventTypeSlug
      );
    }
    return null;
  }

  async getBookedEventTypeTeam(teamSlug: string, organizationSlug: string | undefined) {
    if (!organizationSlug) {
      return await this.teamsRepository.findTeamBySlug(teamSlug);
    }

    const organization = await this.organizationsRepository.findOrgBySlug(organizationSlug);
    if (!organization) {
      throw new NotFoundException(
        `slots-input.service.ts: Organization with slug ${organizationSlug} not found`
      );
    }

    return await this.organizationsTeamsRepository.findOrgTeamBySlug(organization.id, teamSlug);
  }

  async hasRequiredBookingFieldsResponses(body: CreateBookingInput, eventType: EventType | null) {
    const bookingFieldsResponses: Record<string, unknown> = {
      ...body.bookingFieldsResponses,
      attendeePhoneNumber: body.attendee.phoneNumber,
      smsReminderNumber: body.attendee.phoneNumber,
    };
    if (!eventType?.bookingFields) {
      return true;
    }

    // note(Lauris): we filter out system fields, because some of them are set by default and name and email are passed in the body.attendee. Only exception
    // is smsReminderNumber, because if it is required and not passed sms workflow won't work.
    const eventTypeBookingFields = eventTypeBookingFieldsSchema
      .parse(eventType.bookingFields)
      .filter((field) => !field.editable.startsWith("system") || field.name === "smsReminderNumber");

    if (!eventTypeBookingFields.length) {
      return true;
    }

    for (const eventTypeBookingField of eventTypeBookingFields) {
      if (
        eventTypeBookingField.required &&
        (bookingFieldsResponses[eventTypeBookingField.name] === null ||
          bookingFieldsResponses[eventTypeBookingField.name] === undefined)
      ) {
        if (
          eventTypeBookingField.name === "attendeePhoneNumber" ||
          eventTypeBookingField.name === "smsReminderNumber"
        ) {
          throw new BadRequestException(
            `Missing attendee phone number - it is required by the event type. Pass it as "attendee.phoneNumber" string in the request.`
          );
        }
        throw new BadRequestException(
          `Missing required booking field response: ${eventTypeBookingField.name} - it is required by the event type booking fields, but missing in the bookingFieldsResponses. You can fetch the event type with ID ${eventType.id} to see the required fields.`
        );
      }

      const bookingFieldResponseValue = bookingFieldsResponses[eventTypeBookingField.name];
      if (bookingFieldResponseValue !== undefined) {
        const bookingFieldResponseValueType = typeof bookingFieldResponseValue;
        let expectedBookingFieldResponseValueType = "";
        let isValidType = false;
        const eventTypeBookingFieldType = eventTypeBookingField.type;

        switch (eventTypeBookingFieldType) {
          case "phone":
            expectedBookingFieldResponseValueType = "string";
            isValidType = bookingFieldResponseValueType === "string";
            break;
          case "address":
            expectedBookingFieldResponseValueType = "string";
            isValidType = bookingFieldResponseValueType === "string";
            break;
          case "text":
            expectedBookingFieldResponseValueType = "string";
            isValidType = bookingFieldResponseValueType === "string";
            break;
          case "number":
            expectedBookingFieldResponseValueType = "number";
            isValidType = bookingFieldResponseValueType === "number";
            break;
          case "textarea":
            expectedBookingFieldResponseValueType = "string";
            isValidType = bookingFieldResponseValueType === "string";
            break;
          case "multiemail":
            expectedBookingFieldResponseValueType = "array";
            isValidType = Array.isArray(bookingFieldResponseValue);
            break;
          case "boolean":
            expectedBookingFieldResponseValueType = "boolean";
            isValidType = bookingFieldResponseValueType === "boolean";
            break;
          case "select":
            expectedBookingFieldResponseValueType = "string or number";
            isValidType =
              bookingFieldResponseValueType === "string" || bookingFieldResponseValueType === "number";
            if (isValidType && Array.isArray(eventTypeBookingField.options)) {
              const submittedValue = bookingFieldResponseValue as string | number;
              const allowedOptionValues = eventTypeBookingField.options.map((opt) => opt.value);
              if (!this.isValidSingleOptionValue(submittedValue, allowedOptionValues)) {
                throw new BadRequestException(
                  `Invalid option '${submittedValue}' for booking field '${
                    eventTypeBookingField.name
                  }'. Allowed options are: ${allowedOptionValues.join(", ")}.`
                );
              }
            }
            break;
          case "multiselect":
            expectedBookingFieldResponseValueType = "array";
            isValidType = Array.isArray(bookingFieldResponseValue);
            if (isValidType && Array.isArray(eventTypeBookingField.options)) {
              const submittedValues = bookingFieldResponseValue as (string | number)[];
              const allowedOptionValues = eventTypeBookingField.options.map((opt) => opt.value);
              if (!this.areValidMultipleOptionValues(submittedValues, allowedOptionValues)) {
                throw new BadRequestException(
                  `One or more invalid options for booking field '${
                    eventTypeBookingField.name
                  }'. Allowed options are: ${allowedOptionValues.join(", ")}.`
                );
              }
            }
            break;
          case "checkbox":
            expectedBookingFieldResponseValueType = "array";
            isValidType = Array.isArray(bookingFieldResponseValue);
            if (isValidType && Array.isArray(eventTypeBookingField.options)) {
              const submittedValues = bookingFieldResponseValue as (string | number)[];
              const allowedOptionValues = eventTypeBookingField.options.map((opt) => opt.value);
              if (!this.areValidMultipleOptionValues(submittedValues, allowedOptionValues)) {
                throw new BadRequestException(
                  `One or more invalid options for booking field '${
                    eventTypeBookingField.name
                  }'. Allowed options are: ${allowedOptionValues.join(", ")}.`
                );
              }
            }
            break;
          case "radio":
            expectedBookingFieldResponseValueType = "string or number";
            isValidType =
              bookingFieldResponseValueType === "string" || bookingFieldResponseValueType === "number";
            if (isValidType && Array.isArray(eventTypeBookingField.options)) {
              const submittedValue = bookingFieldResponseValue as string | number;
              const allowedOptionValues = eventTypeBookingField.options.map((opt) => opt.value);
              if (!this.isValidSingleOptionValue(submittedValue, allowedOptionValues)) {
                throw new BadRequestException(
                  `Invalid option '${submittedValue}' for booking field '${
                    eventTypeBookingField.name
                  }'. Allowed options are: ${allowedOptionValues.join(", ")}.`
                );
              }
            }
            break;
          case "url":
            expectedBookingFieldResponseValueType = "string";
            isValidType = bookingFieldResponseValueType === "string";
            break;
          default:
            // note(Lauris): by default pass the field if we have a missing "case" in the switch
            isValidType = true;
            break;
        }

        if (!isValidType) {
          throw new BadRequestException(
            `Invalid type for booking field '${eventTypeBookingField.name}'. Expected type ${expectedBookingFieldResponseValueType} (compatible with field type '${eventTypeBookingFieldType}'), but received ${bookingFieldResponseValueType}.`
          );
        }
      }
    }

    return true;
  }

  private isValidSingleOptionValue(
    bookingFieldResponseValue: string | number,
    eventTypeBookingFieldOptions: string[]
  ): boolean {
    if (eventTypeBookingFieldOptions.length === 0) {
      // note(Lauris): If no options defined, cannot validate against them, so pass.
      return true;
    }
    return eventTypeBookingFieldOptions.some((val) => val === String(bookingFieldResponseValue));
  }

  private areValidMultipleOptionValues(
    bookingFieldResponseValues: (string | number)[],
    eventTypeBookingFieldOptions: string[]
  ): boolean {
    if (eventTypeBookingFieldOptions.length === 0) {
      // note(Lauris): If no options defined, cannot validate against them, so pass.
      return true;
    }
    return bookingFieldResponseValues.every((submittedVal) =>
      eventTypeBookingFieldOptions.some((allowedVal) => allowedVal === String(submittedVal))
    );
  }

  async createInstantBooking(
    request: Request,
    body: CreateInstantBookingInput_2024_08_13,
    eventType: EventTypeWithOwnerAndTeam
  ) {
    if (!eventType.team?.id) {
      throw new BadRequestException(
        "Instant bookings are only supported for team event types, not individual user event types."
      );
    }

    const bookingRequest = await this.inputService.createBookingRequest(request, body, eventType);
    const booking = await handleInstantMeeting(bookingRequest);

    const databaseBooking = await this.bookingsRepository.getByIdWithAttendeesAndUserAndEvent(
      booking.bookingId
    );
    if (!databaseBooking) {
      throw new Error(`Booking with id=${booking.bookingId} was not found in the database`);
    }

    return this.outputService.getOutputBooking(databaseBooking);
  }

  async createRecurringBooking(
    request: Request,
    body: CreateRecurringBookingInput_2024_08_13,
    eventType: EventTypeWithOwnerAndTeam
  ) {
    const bookingRequest = await this.inputService.createRecurringBookingRequest(request, body, eventType);
    const bookings = await handleNewRecurringBooking({
      bookingData: bookingRequest.body,
      userId: bookingRequest.userId,
      hostname: bookingRequest.headers?.host || "",
      platformClientId: bookingRequest.platformClientId,
      platformRescheduleUrl: bookingRequest.platformRescheduleUrl,
      platformCancelUrl: bookingRequest.platformCancelUrl,
      platformBookingUrl: bookingRequest.platformBookingUrl,
      platformBookingLocation: bookingRequest.platformBookingLocation,
      noEmail: bookingRequest.noEmail,
      areCalendarEventsEnabled: bookingRequest.areCalendarEventsEnabled,
    });
    const ids = bookings.map((booking) => booking.id || 0);
    return this.outputService.getOutputRecurringBookings(ids);
  }

  async createRecurringSeatedBooking(
    request: Request,
    body: CreateRecurringBookingInput_2024_08_13,
    eventType: EventTypeWithOwnerAndTeam
  ) {
    const bookingRequest = await this.inputService.createRecurringBookingRequest(request, body, eventType);
    const bookings = await handleNewRecurringBooking({
      bookingData: bookingRequest.body,
      userId: bookingRequest.userId,
      hostname: bookingRequest.headers?.host || "",
      platformClientId: bookingRequest.platformClientId,
      platformRescheduleUrl: bookingRequest.platformRescheduleUrl,
      platformCancelUrl: bookingRequest.platformCancelUrl,
      platformBookingUrl: bookingRequest.platformBookingUrl,
      platformBookingLocation: bookingRequest.platformBookingLocation,
      areCalendarEventsEnabled: bookingRequest.areCalendarEventsEnabled,
    });
    return this.outputService.getOutputCreateRecurringSeatedBookings(
      bookings.map((booking) => ({ uid: booking.uid || "", seatUid: booking.seatReferenceUid || "" }))
    );
  }

  async createRegularBooking(
    request: Request,
    body: CreateBookingInput_2024_08_13,
    eventType: EventTypeWithOwnerAndTeam
  ) {
    const bookingRequest = await this.inputService.createBookingRequest(request, body, eventType);
    const booking = await handleNewBooking({
      bookingData: bookingRequest.body,
      userId: bookingRequest.userId,
      hostname: bookingRequest.headers?.host || "",
      platformClientId: bookingRequest.platformClientId,
      platformRescheduleUrl: bookingRequest.platformRescheduleUrl,
      platformCancelUrl: bookingRequest.platformCancelUrl,
      platformBookingUrl: bookingRequest.platformBookingUrl,
      platformBookingLocation: bookingRequest.platformBookingLocation,
      areCalendarEventsEnabled: bookingRequest.areCalendarEventsEnabled,
    });

    if (!booking.uid) {
      throw new Error("Booking missing uid");
    }

    const databaseBooking = await this.bookingsRepository.getByUidWithAttendeesAndUserAndEvent(booking.uid);
    if (!databaseBooking) {
      throw new Error(`Booking with uid=${booking.uid} was not found in the database`);
    }

    return this.outputService.getOutputBooking(databaseBooking);
  }

  async createSeatedBooking(
    request: Request,
    body: CreateBookingInput_2024_08_13,
    eventType: EventTypeWithOwnerAndTeam
  ) {
    const bookingRequest = await this.inputService.createBookingRequest(request, body, eventType);
    try {
      const booking = await handleNewBooking({
        bookingData: bookingRequest.body,
        userId: bookingRequest.userId,
        hostname: bookingRequest.headers?.host || "",
        platformClientId: bookingRequest.platformClientId,
        platformRescheduleUrl: bookingRequest.platformRescheduleUrl,
        platformCancelUrl: bookingRequest.platformCancelUrl,
        platformBookingUrl: bookingRequest.platformBookingUrl,
        platformBookingLocation: bookingRequest.platformBookingLocation,
        areCalendarEventsEnabled: bookingRequest.areCalendarEventsEnabled,
      });

      if (!booking.uid) {
        throw new Error("Booking missing uid");
      }

      const databaseBooking =
        await this.bookingsRepository.getByUidWithAttendeesWithBookingSeatAndUserAndEvent(booking.uid);
      if (!databaseBooking) {
        throw new Error(`Booking with uid=${booking.uid} was not found in the database`);
      }

      return this.outputService.getOutputCreateSeatedBooking(databaseBooking, booking.seatReferenceUid || "");
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "booking_seats_full_error") {
          throw new ConflictException("No more seats left at this seated booking.");
        }
      }
      throw error;
    }
  }

  async getBooking(uid: string) {
    const booking = await this.bookingsRepository.getByUidWithAttendeesWithBookingSeatAndUserAndEvent(uid);

    if (booking) {
      const isRecurring = !!booking.recurringEventId;
      const isSeated = !!booking.eventType?.seatsPerTimeSlot;

      if (isRecurring && !isSeated) {
        return this.outputService.getOutputRecurringBooking(booking);
      }
      if (isRecurring && isSeated) {
        return this.outputService.getOutputRecurringSeatedBooking(booking);
      }
      if (isSeated) {
        return this.outputService.getOutputSeatedBooking(booking);
      }
      return this.outputService.getOutputBooking(booking);
    }

    const recurringBooking = await this.bookingsRepository.getRecurringByUidWithAttendeesAndUserAndEvent(uid);
    if (!recurringBooking.length) {
      throw new NotFoundException(`Booking with uid=${uid} was not found in the database`);
    }
    const ids = recurringBooking.map((booking) => booking.id);
    const isRecurringSeated = !!recurringBooking[0].eventType?.seatsPerTimeSlot;
    if (isRecurringSeated) {
      return this.outputService.getOutputRecurringSeatedBookings(ids);
    }

    return this.outputService.getOutputRecurringBookings(ids);
  }

  async getBookings(
    queryParams: GetBookingsInput_2024_08_13,
    user: { email: string; id: number; orgId?: number },
    userIds?: number[]
  ) {
    if (queryParams.attendeeEmail) {
      queryParams.attendeeEmail = await this.getAttendeeEmail(queryParams.attendeeEmail, user);
    }

    const skip = Math.abs(queryParams?.skip ?? 0);
    const take = Math.abs(queryParams?.take ?? 100);

    const fetchedBookings: { bookings: { id: number }[]; totalCount: number } = await getAllUserBookings({
      bookingListingByStatus: queryParams.status || [],
      skip,
      take,
      filters: {
        ...this.inputService.transformGetBookingsFilters(queryParams),
        ...(userIds?.length ? { userIds } : {}),
      },
      ctx: {
        user,
        prisma: this.prismaReadService.prisma as unknown as PrismaClient,
        kysely: this.kyselyReadService.kysely,
      },
      sort: this.inputService.transformGetBookingsSort(queryParams),
    });
    // note(Lauris): fetchedBookings don't have attendees information and responses and i don't want to add them to the handler query,
    // because its used elsewhere in code that does not need that information, so i get ids, fetch bookings and then return them formatted in same order as ids.
    const ids = fetchedBookings.bookings.map((booking) => booking.id);
    const bookings = await this.bookingsRepository.getByIdsWithAttendeesWithBookingSeatAndUserAndEvent(ids);

    const bookingMap = new Map(bookings.map((booking) => [booking.id, booking]));
    const orderedBookings = ids.map((id) => bookingMap.get(id));

    const formattedBookings: (
      | BookingOutput_2024_08_13
      | RecurringBookingOutput_2024_08_13
      | GetSeatedBookingOutput_2024_08_13
      | GetRecurringSeatedBookingOutput_2024_08_13
    )[] = [];
    for (const booking of orderedBookings) {
      if (!booking) {
        continue;
      }

      const formatted = {
        ...booking,
        eventType: booking.eventType,
        eventTypeId: booking.eventTypeId,
        startTime: new Date(booking.startTime),
        endTime: new Date(booking.endTime),
        absentHost: !!booking.noShowHost,
      };

      const isRecurring = !!formatted.recurringEventId;
      const isSeated = !!formatted.eventType?.seatsPerTimeSlot;
      if (isRecurring && !isSeated) {
        formattedBookings.push(this.outputService.getOutputRecurringBooking(formatted));
      } else if (isRecurring && isSeated) {
        formattedBookings.push(this.outputService.getOutputRecurringSeatedBooking(formatted));
      } else if (isSeated) {
        formattedBookings.push(await this.outputService.getOutputSeatedBooking(formatted));
      } else {
        formattedBookings.push(await this.outputService.getOutputBooking(formatted));
      }
    }

    const pagination = getPagination({ skip, take, totalCount: fetchedBookings.totalCount });

    return {
      bookings: formattedBookings,
      pagination,
    };
  }

  async getAttendeeEmail(queryParamsAttendeeEmail: string, user: { id: number }) {
    // note(Lauris): this is to handle attendees that are managed users - in attendee table their email is one of managed users e.g
    // urdasdqinm+clxyyy21o0003sbk7yw5z6tzg@example.com but if attendeeEmail is passed as urdasdqinm@example.com then we check if user whose
    // access token is used is a managed user and if attendee with passed email has managed user email composed of passed email without oAuth client id +
    // authenticated user oAuth client id.
    const oAuthClient = await this.oAuthClientRepository.getByUserId(user.id);
    if (!oAuthClient) {
      return queryParamsAttendeeEmail;
    }
    // note(Lauris): query param already contains oAuth client id in the attendeeEmail
    if (queryParamsAttendeeEmail.includes(oAuthClient.id)) {
      return queryParamsAttendeeEmail;
    }

    const managedAttendeeEmail = OAuthClientUsersService.getOAuthUserEmail(
      oAuthClient.id,
      queryParamsAttendeeEmail
    );
    const [attendee, managedAttendee] = await Promise.all([
      this.usersRepository.findByEmail(queryParamsAttendeeEmail),
      this.usersRepository.findByEmail(managedAttendeeEmail),
    ]);
    if (!attendee && managedAttendee) {
      return managedAttendeeEmail;
    }

    return queryParamsAttendeeEmail;
  }

  async rescheduleBooking(request: Request, bookingUid: string, body: RescheduleBookingInput) {
    try {
      await this.canRescheduleBooking(bookingUid);
      const bookingRequest = await this.inputService.createRescheduleBookingRequest(
        request,
        bookingUid,
        body
      );
      const booking = await handleNewBooking({
        bookingData: bookingRequest.body,
        userId: bookingRequest.userId,
        hostname: bookingRequest.headers?.host || "",
        platformClientId: bookingRequest.platformClientId,
        platformRescheduleUrl: bookingRequest.platformRescheduleUrl,
        platformCancelUrl: bookingRequest.platformCancelUrl,
        platformBookingUrl: bookingRequest.platformBookingUrl,
        platformBookingLocation: bookingRequest.platformBookingLocation,
        areCalendarEventsEnabled: bookingRequest.areCalendarEventsEnabled,
      });
      if (!booking.uid) {
        throw new Error("Booking missing uid");
      }

      const databaseBooking =
        await this.bookingsRepository.getByUidWithAttendeesWithBookingSeatAndUserAndEvent(booking.uid);
      if (!databaseBooking) {
        throw new Error(`Booking with uid=${booking.uid} was not found in the database`);
      }

      const isRecurring = !!databaseBooking.recurringEventId;
      const isSeated = !!databaseBooking.eventType?.seatsPerTimeSlot;

      if (isRecurring && !isSeated) {
        return this.outputService.getOutputRecurringBooking(databaseBooking);
      }
      if (isRecurring && isSeated) {
        return this.outputService.getOutputCreateRecurringSeatedBooking(
          databaseBooking,
          booking?.seatReferenceUid || ""
        );
      }
      if (isSeated) {
        return this.outputService.getOutputCreateSeatedBooking(
          databaseBooking,
          booking.seatReferenceUid || ""
        );
      }
      return this.outputService.getOutputBooking(databaseBooking);
    } catch (error) {
      this.errorsBookingsService.handleBookingError(error, false);
    }
  }

  async canRescheduleBooking(bookingUid: string) {
    const booking = await this.bookingsRepository.getByUid(bookingUid);
    if (!booking) {
      throw new Error(`Booking with uid=${bookingUid} was not found in the database`);
    }
    if (booking.status === "CANCELLED" && !booking.rescheduled) {
      throw new BadRequestException(
        `Can't reschedule booking with uid=${bookingUid} because it has been cancelled. Please provide uid of a booking that is not cancelled.`
      );
    }
    if (booking.status === "CANCELLED" && booking.rescheduled) {
      const rescheduledTo = await this.bookingsRepository.getByFromReschedule(bookingUid);
      throw new BadRequestException(
        `Can't reschedule booking with uid=${bookingUid} because it has been cancelled and rescheduled already to booking with uid=${rescheduledTo?.uid}. You probably want to reschedule ${rescheduledTo?.uid} instead by passing it within the request URL.`
      );
    }
    return booking;
  }

  async cancelBooking(request: Request, bookingUid: string, body: CancelBookingInput) {
    if (this.inputService.isCancelSeatedBody(body)) {
      const seat = await this.bookingSeatRepository.getByReferenceUid(body.seatUid);

      if (!seat) {
        throw new BadRequestException(
          "Invalid seatUid: this seat does not exist or has already been cancelled."
        );
      }

      if (seat && bookingUid !== seat.booking.uid) {
        throw new BadRequestException("Invalid seatUid: this seat does not belong to this booking.");
      }
    }

    const bookingRequest = await this.inputService.createCancelBookingRequest(request, bookingUid, body);
    const res = await handleCancelBooking({
      bookingData: bookingRequest.body,
      userId: bookingRequest.userId,
      arePlatformEmailsEnabled: bookingRequest.arePlatformEmailsEnabled,
      platformClientId: bookingRequest.platformClientId,
      platformCancelUrl: bookingRequest.platformCancelUrl,
      platformRescheduleUrl: bookingRequest.platformRescheduleUrl,
      platformBookingUrl: bookingRequest.platformBookingUrl,
    });

    if (!res.onlyRemovedAttendee) {
      await this.billingService.cancelUsageByBookingUid(res.bookingUid);
    }

    if ("cancelSubsequentBookings" in body && body.cancelSubsequentBookings) {
      return this.getAllRecurringBookingsByIndividualUid(bookingUid);
    }

    return this.getBooking(bookingUid);
  }

  private async getAllRecurringBookingsByIndividualUid(bookingUid: string) {
    const booking = await this.bookingsRepository.getByUid(bookingUid);
    const recurringBookingUid = booking?.recurringEventId;
    if (!recurringBookingUid) {
      throw new BadRequestException(
        `Booking with bookingUid=${bookingUid} is not part of a recurring booking.`
      );
    }

    return await this.getBooking(recurringBookingUid);
  }

  async markAbsent(bookingUid: string, bookingOwnerId: number, body: MarkAbsentBookingInput_2024_08_13) {
    const bodyTransformed = this.inputService.transformInputMarkAbsentBooking(body);
    const bookingBefore = await this.bookingsRepository.getByUid(bookingUid);

    if (!bookingBefore) {
      throw new NotFoundException(`Booking with uid=${bookingUid} not found.`);
    }

    const nowUtc = DateTime.utc();
    const bookingStartTimeUtc = DateTime.fromJSDate(bookingBefore.startTime, { zone: "utc" });

    if (nowUtc < bookingStartTimeUtc) {
      throw new BadRequestException(
        `Bookings can only be marked as absent after their scheduled start time. Current time in UTC+0: ${nowUtc.toISO()}, Booking start time in UTC+0: ${bookingStartTimeUtc.toISO()}`
      );
    }

    const platformClientParams = bookingBefore?.eventTypeId
      ? await this.platformBookingsService.getOAuthClientParams(bookingBefore.eventTypeId)
      : undefined;

    await handleMarkNoShow({
      bookingUid,
      attendees: bodyTransformed.attendees,
      noShowHost: bodyTransformed.noShowHost,
      userId: bookingOwnerId,
      platformClientParams,
    });

    const booking = await this.bookingsRepository.getByUidWithAttendeesAndUserAndEvent(bookingUid);

    if (!booking) {
      throw new Error(`Booking with uid=${bookingUid} was not found in the database`);
    }

    const isRecurring = !!booking.recurringEventId;
    if (isRecurring) {
      return this.outputService.getOutputRecurringBooking(booking);
    }
    return this.outputService.getOutputBooking(booking);
  }

  async billBookings(bookings: CreatedBooking[]) {
    for (const booking of bookings) {
      await this.billBooking(booking);
    }
  }

  async billBooking(booking: CreatedBooking) {
    const hostId = booking.hosts?.[0]?.id;
    if (!hostId) {
      this.logger.error(`Booking with uid=${booking.uid} has no host`);
      return;
    }

    await this.billingService.increaseUsageByUserId(hostId, {
      uid: booking.uid,
      startTime: new Date(booking.start),
    });
  }

  async billRescheduledBooking(newBooking: CreatedBooking, oldBookingUid: string) {
    const hostId = newBooking.hosts[0].id;
    if (!hostId) {
      this.logger.error(`Booking with uid=${newBooking.uid} has no host`);
      return;
    }

    await this.billingService.increaseUsageByUserId(hostId, {
      uid: newBooking.uid,
      startTime: new Date(newBooking.start),
      fromReschedule: oldBookingUid,
    });
  }

  async reassignBooking(bookingUid: string, requestUser: UserWithProfile) {
    const booking = await this.bookingsRepository.getByUid(bookingUid);
    if (!booking) {
      throw new NotFoundException(`Booking with uid=${bookingUid} was not found in the database`);
    }

    const platformClientParams = booking.eventTypeId
      ? await this.platformBookingsService.getOAuthClientParams(booking.eventTypeId)
      : undefined;

    const emailsEnabled = platformClientParams ? platformClientParams.arePlatformEmailsEnabled : true;

    const profile = this.usersService.getUserMainProfile(requestUser);

    try {
      await roundRobinReassignment({
        bookingId: booking.id,
        orgId: profile?.organizationId || null,
        emailsEnabled,
        platformClientParams,
        reassignedById: requestUser.id,
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "no_available_users_found_error") {
          throw new BadRequestException(
            "Can't reassign the booking because no other host is available at that time."
          );
        }
      }
      throw error;
    }

    const reassigned = await this.bookingsRepository.getByUidWithUser(bookingUid);
    if (!reassigned) {
      throw new NotFoundException(`Reassigned booking with uid=${bookingUid} was not found in the database`);
    }

    return this.outputService.getOutputReassignedBooking(reassigned);
  }

  async reassignBookingToUser(
    bookingUid: string,
    newUserId: number,
    reassignedById: number,
    body: ReassignToUserBookingInput_2024_08_13
  ) {
    const booking = await this.bookingsRepository.getByUid(bookingUid);
    if (!booking) {
      throw new NotFoundException(`Booking with uid=${bookingUid} was not found in the database`);
    }

    const user = await this.usersRepository.findByIdWithProfile(newUserId);
    if (!user) {
      throw new NotFoundException(`User with id=${newUserId} was not found in the database`);
    }

    const platformClientParams = booking.eventTypeId
      ? await this.platformBookingsService.getOAuthClientParams(booking.eventTypeId)
      : undefined;

    const emailsEnabled = platformClientParams ? platformClientParams.arePlatformEmailsEnabled : true;

    const profile = this.usersService.getUserMainProfile(user);

    try {
      const reassigned = await roundRobinManualReassignment({
        bookingId: booking.id,
        newUserId,
        orgId: profile?.organizationId || null,
        reassignReason: body.reason,
        reassignedById,
        emailsEnabled,
        platformClientParams,
      });

      return this.outputService.getOutputReassignedBooking(reassigned);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "invalid_round_robin_host") {
          throw new BadRequestException(
            `User with id=${newUserId} is not a valid Round Robin host - the user to which you reassign this booking must be one of the booking hosts. Fetch the booking using following endpoint and select id of one of the hosts: https://cal.com/docs/api-reference/v2/bookings/get-a-booking`
          );
        }
      }
      throw error;
    }
  }

  async confirmBooking(bookingUid: string, requestUser: UserWithProfile) {
    const booking = await this.bookingsRepository.getByUid(bookingUid);
    if (!booking) {
      throw new NotFoundException(`Booking with uid=${bookingUid} was not found in the database`);
    }

    const platformClientParams = booking.eventTypeId
      ? await this.platformBookingsService.getOAuthClientParams(booking.eventTypeId)
      : undefined;

    const emailsEnabled = platformClientParams ? platformClientParams.arePlatformEmailsEnabled : true;
    const userCalendars = await this.usersRepository.findByIdWithCalendars(requestUser.id);

    await confirmBookingHandler({
      ctx: {
        user: {
          ...requestUser,
          destinationCalendar: userCalendars?.destinationCalendar ?? null,
        },
      },
      input: {
        bookingId: booking.id,
        confirmed: true,
        recurringEventId: booking.recurringEventId ?? undefined,
        emailsEnabled,
        platformClientParams,
      },
    });

    return this.getBooking(bookingUid);
  }

  async declineBooking(bookingUid: string, requestUser: UserWithProfile, reason?: string) {
    const booking = await this.bookingsRepository.getByUid(bookingUid);
    if (!booking) {
      throw new NotFoundException(`Booking with uid=${bookingUid} was not found in the database`);
    }

    const platformClientParams = booking.eventTypeId
      ? await this.platformBookingsService.getOAuthClientParams(booking.eventTypeId)
      : undefined;

    const emailsEnabled = platformClientParams ? platformClientParams.arePlatformEmailsEnabled : true;
    const userCalendars = await this.usersRepository.findByIdWithCalendars(requestUser.id);

    await confirmBookingHandler({
      ctx: {
        user: {
          ...requestUser,
          destinationCalendar: userCalendars?.destinationCalendar ?? null,
        },
      },
      input: {
        bookingId: booking.id,
        confirmed: false,
        recurringEventId: booking.recurringEventId ?? undefined,
        reason,
        emailsEnabled,
        platformClientParams,
      },
    });

    return this.getBooking(bookingUid);
  }

  async getCalendarLinks(bookingUid: string): Promise<CalendarLink[]> {
    const booking = await this.bookingsRepository.getByUidWithAttendeesAndUserAndEvent(bookingUid);

    if (!booking) {
      throw new NotFoundException(`Booking with uid ${bookingUid} not found`);
    }

    if (!booking.eventTypeId) {
      throw new BadRequestException(`Booking with uid ${bookingUid} has no event type`);
    }

    const eventType = await this.eventTypesRepository.getEventTypeByIdIncludeUsersAndTeam(
      booking.eventTypeId
    );
    if (!eventType) {
      throw new BadRequestException(`Booking with uid ${bookingUid} has no event type`);
    }
    // TODO: Maybe we should get locale from query params?
    return getCalendarLinks({
      booking,
      eventType: {
        ...eventType,
        // TODO: Support dynamic event bookings later. It would require a slug input it seems
        isDynamic: false,
      },
      // It can be made customizable through the API endpoint later.
      t: await getTranslation("en", "common"),
    });
  }
}
