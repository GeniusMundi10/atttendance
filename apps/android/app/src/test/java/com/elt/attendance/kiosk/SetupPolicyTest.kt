// PURPOSE: Cover the validation rules used by the unmanaged kiosk first-run setup.
package com.elt.attendance.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SetupPolicyTest {
    @Test
    fun acceptsOnlyAnHttpsServerOrigin() {
        assertEquals("https://attendance.example", SetupPolicy.origin("https://attendance.example/"))
        assertThrows(IllegalArgumentException::class.java) { SetupPolicy.origin("http://attendance.example") }
        assertThrows(IllegalArgumentException::class.java) { SetupPolicy.origin("https://user@attendance.example") }
        assertThrows(IllegalArgumentException::class.java) { SetupPolicy.origin("https://attendance.example/api") }
        assertThrows(IllegalArgumentException::class.java) { SetupPolicy.origin("https://attendance.example?x=1") }
    }

    @Test
    fun validatesIntegrityProjectAndAdministratorPin() {
        assertEquals(123456789L, SetupPolicy.cloudProject(" 123456789 "))
        assertThrows(IllegalArgumentException::class.java) { SetupPolicy.cloudProject("0") }
        assertThrows(IllegalArgumentException::class.java) { SetupPolicy.cloudProject("project") }
        assertTrue(SetupPolicy.validPin("12345678"))
        assertFalse(SetupPolicy.validPin("1234567"))
        assertFalse(SetupPolicy.validPin("1234abcd"))
        assertTrue(SetupPolicy.validPin("123456789012".toCharArray()))
        assertFalse(SetupPolicy.validPin("1234abcd".toCharArray()))
    }

    @Test
    fun requiresCanonicalEmployeeUuid() {
        assertEquals("123e4567-e89b-12d3-a456-426614174000", SetupPolicy.employeeId("123e4567-e89b-12d3-a456-426614174000"))
        assertThrows(IllegalArgumentException::class.java) { SetupPolicy.employeeId("not-an-employee") }
    }
}
